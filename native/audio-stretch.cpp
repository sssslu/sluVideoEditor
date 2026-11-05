// SLU Studio continuous, bounded, pitch-preserving audio time-map worker.
// GPL-3.0-or-later. Rubber Band4.0.0 + reproducible SLU patch: GPL-2.0-or-later.
#include "single/RubberBandSingle.cpp"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

namespace {
constexpr size_t rate=48000,channels=2,blockSize=4096;
struct Segment {double from,to,speed,slope,source,end;};
void process(const std::string &header) {
    std::istringstream parser(header);std::string magic,extra;
    size_t inputFrames=0,outputFrames=0,cropStart=0,cropFrames=0,pointCount=0;double duration=0,sourceOffset=0;
    if(!(parser>>magic>>inputFrames>>outputFrames>>cropStart>>cropFrames>>pointCount>>duration>>sourceOffset)||(magic!="SLURB2"&&magic!="SLURB3"))throw std::runtime_error("Invalid audio worker header");
    double renderFrom=0,renderTo=duration;
    if(magic=="SLURB3"&&!(parser>>renderFrom>>renderTo))throw std::runtime_error("Missing audio render range");
    if(parser>>extra)throw std::runtime_error("Invalid audio worker header");
    if(inputFrames==0||inputFrames>uint64_t(rate)*864010||outputFrames==0||outputFrames>uint64_t(rate)*86410||cropFrames==0||cropFrames>uint64_t(rate)*86400||cropStart>outputFrames||cropFrames>outputFrames-cropStart||pointCount<2||pointCount>64||!std::isfinite(duration)||duration<.01||duration>86400||!std::isfinite(sourceOffset)||std::abs(sourceOffset)>864010||!std::isfinite(renderFrom)||!std::isfinite(renderTo)||renderFrom< -86400||renderTo>86400||renderTo<=renderFrom||renderTo-renderFrom>86400)throw std::runtime_error("Audio worker limits exceeded");
    const double ratio=double(outputFrames)/inputFrames;if(ratio<.04||ratio>12.0)throw std::runtime_error("Audio time ratio is out of bounds");
    std::vector<Segment> segments;double previousPosition=0,previousSpeed=0,sourceEnd=0;
    for(size_t i=0;i<pointCount;++i){std::string line;if(!std::getline(std::cin,line)||line.size()>128)throw std::runtime_error("Missing audio speed map");std::istringstream row(line);double position=0,speed=0;if(!(row>>position>>speed)||(row>>extra)||!std::isfinite(position)||!std::isfinite(speed)||position<0||position>1||speed<.1||speed>16||(i==0&&position!=0)||(i&&position-previousPosition<1e-12)||(i+1==pointCount&&position!=1))throw std::runtime_error("Invalid audio speed map");if(i){const double from=previousPosition*duration,to=position*duration,end=sourceEnd+(to-from)*(previousSpeed+speed)/2;if(!(to>from)||!std::isfinite(end)||!(end>sourceEnd))throw std::runtime_error("Invalid audio segment bounds");segments.push_back({from,to,previousSpeed,(speed-previousSpeed)/(to-from),sourceEnd,end});sourceEnd=end;}previousPosition=position;previousSpeed=speed;}
    const double finalSpeed=previousSpeed;
    auto inverse=[&](double source){if(source<0)return source/segments.front().speed;auto found=std::lower_bound(segments.begin(),segments.end(),source,[](const Segment&part,double value){return part.end<value;});if(found==segments.end())return duration+(source-sourceEnd)/finalSpeed;const auto&p=*found;const double x=std::max(0.0,source-p.source),local=std::abs(p.slope)<1e-12?x/p.speed:2*x/(p.speed+std::sqrt(std::max(0.0,p.speed*p.speed+2*p.slope*x)));return p.from+local;};
    const double timelineOffset=inverse(sourceOffset);
    auto timeline=[&](double sourceSample){return (inverse(sourceOffset+sourceSample/rate)-timelineOffset)*rate;};
    if(std::abs(timeline(double(inputFrames))-double(outputFrames))>4||std::abs((renderFrom-timelineOffset)*rate-double(cropStart))>2||std::abs((renderTo-renderFrom)*rate-double(cropFrames))>2)throw std::runtime_error("Inconsistent audio timeline bounds");
    using R=RubberBand::RubberBandStretcher;
    RubberBand::Log log([](const char*m){std::cerr<<m<<'\n';},[](const char*m,double a){std::cerr<<m<<": "<<a<<'\n';},[](const char*m,double a,double b){std::cerr<<m<<": "<<a<<", "<<b<<'\n';});
    // Keep source channels independent. Mid/side conversion (ChannelsTogether)
    // couples unrelated transients between channels at extreme slow rates.
    RubberBand::R3Stretcher stretch({double(rate),int(channels),R::OptionProcessOffline|R::OptionThreadingNever|R::OptionEngineFiner},ratio,1.0,log);
    stretch.setExpectedInputDuration(inputFrames);stretch.setMaxProcessSize(blockSize);stretch.setSourceTimeMap(timeline);
    // R3's study pass only records input duration; it does not inspect audio.
    // Supplying the known duration keeps decoding single-pass and bounded.
    stretch.study(nullptr,inputFrames,true);
    std::vector<float> left(blockSize),right(blockSize),interleaved(blockSize*channels),outLeft(blockSize),outRight(blockSize),output(blockSize*channels);size_t produced=0,copied=0;
    auto drain=[&](){while(stretch.available()>0){const size_t request=std::min(blockSize,size_t(stretch.available()));float* planes[]={outLeft.data(),outRight.data()};const size_t count=stretch.retrieve(planes,request);if(!count)throw std::runtime_error("Audio worker made no progress");size_t written=0;for(size_t i=0;i<count;++i){const size_t index=produced+i;if(index>=cropStart&&index-cropStart<cropFrames){output[written*channels]=std::isfinite(outLeft[i])?outLeft[i]:0;output[written*channels+1]=std::isfinite(outRight[i])?outRight[i]:0;++written;}}if(written){std::cout.write(reinterpret_cast<const char*>(output.data()),written*channels*sizeof(float));std::cout.flush();if(!std::cout)throw std::runtime_error("Audio output pipe closed");copied+=written;}produced+=count;}};
    for(size_t at=0;at<inputFrames;at+=blockSize){const size_t count=std::min(blockSize,inputFrames-at);std::cin.read(reinterpret_cast<char*>(interleaved.data()),count*channels*sizeof(float));if(size_t(std::cin.gcount())!=count*channels*sizeof(float))throw std::runtime_error("Incomplete audio PCM input");for(size_t i=0;i<count;++i){left[i]=std::isfinite(interleaved[2*i])?interleaved[2*i]:0;right[i]=std::isfinite(interleaved[2*i+1])?interleaved[2*i+1]:0;}const float* planes[]={left.data(),right.data()};stretch.process(planes,count,at+count==inputFrames);drain();}drain();
    if(copied!=cropFrames)throw std::runtime_error("Stretched audio did not cover the requested timeline range");
}
}

int main(int argc,char**argv){
    if(argc==2&&std::string(argv[1])=="--version"){std::cout<<"SLU Audio Stretch3 / Rubber Band4.0.0 + SLU exact-hop time map / extended render ranges / 48000Hz stereo float32 / GPL-3.0-or-later\n";return 0;}
    if(argc!=1){std::cerr<<"Usage: slu-audio-stretch.exe < binary-worker-protocol > float32-PCM\n";return 2;}
#ifdef _WIN32
    _setmode(_fileno(stdin),_O_BINARY);_setmode(_fileno(stdout),_O_BINARY);
#endif
    std::ios::sync_with_stdio(false);std::cin.tie(nullptr);
    try{std::string header;if(!std::getline(std::cin,header)||header.size()>256)throw std::runtime_error("Invalid audio header");process(header);}
    catch(const std::exception&error){std::cerr<<error.what()<<'\n';return 1;}return 0;
}
