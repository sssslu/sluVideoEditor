// Reproducible, narrowly scoped GPL-2.0-or-later modification to Rubber Band4.0.0.
// Evaluate a continuous source-to-output timeline at each analysis hop. Upstream
// key-frame maps update only once per process() call, which is too coarse for
// very slow variable rates. The audio FFT and phase state remain continuous.
import {promises as fs} from 'node:fs';
import path from 'node:path';
export async function patchRubberBand(source){
  const header=path.join(source,'src/finer/R3Stretcher.h'),implementation=path.join(source,'src/finer/R3Stretcher.cpp'),phaseFile=path.join(source,'src/finer/PhaseAdvance.h');
  let h=await fs.readFile(header,'utf8'),cpp=await fs.readFile(implementation,'utf8'),phase=await fs.readFile(phaseFile,'utf8');
  const replace=(value,search,replacement)=>{if(value.split(search).length!==2)throw Error('Rubber Band patch anchor changed');return value.replace(search,replacement);};
  h=replace(h,'    void reset();','    void setSourceTimeMap(std::function<double(double)> map) { m_sourceTimeMap = std::move(map); }\n    void reset();');
  h=replace(h,'protected:\n','protected:\n    std::function<double(double)> m_sourceTimeMap;\n');
  cpp=replace(cpp,'        int readSpace = cd0->inbuf->getReadSpace();',`        // SLU: integrate the exact output timeline over each analysis hop.
        // The phase advance below continues to use the previous actual hops.
        if (m_sourceTimeMap) {
            const double source = double(m_consumedInputDuration);
            const double target = m_sourceTimeMap(source);
            m_timeRatio = m_sourceTimeMap(source + 1.0) - target;
            calculateHop();
            inhop = m_inhop;
            outhop = std::max(1, int(std::llround(m_sourceTimeMap(source + inhop)) - std::llround(target)));
            // A sharp rate bend may cross this hop. Retain sufficient output
            // window overlap instead of letting an old local rate create a
            // synthesis hop larger than the phase-vocoder window supports.
            while (inhop > 1 && outhop > m_limits.maxPreferredOuthop) {
                inhop = std::max(1, inhop / 2);
                outhop = std::max(1, int(std::llround(m_sourceTimeMap(source + inhop)) - std::llround(target)));
            }
        }

        int readSpace = cd0->inbuf->getReadSpace();`);
  phase=replace(phase,'        for (int c = 0; c < channels; ++c) {\n            for (int i = lowest; i <= highest; ++i) {\n                m_prevInPhase',`        // SLU: retain the source inter-channel phase difference in every bin.
        // The loudest channel supplies the common phase advance, while each
        // channel retains its own magnitude/transient analysis. This avoids
        // both stereo-image drift and mid/side transient cross-contamination.
        if (channels > 1 && !usingMidSide) {
            for (int i = lowest; i <= highest; ++i) {
                const int reference = m_greatestChannel[i];
                const process_t advanced = outPhase[reference][i];
                for (int c = 0; c < channels; ++c) {
                    if (c != reference) {
                        outPhase[c][i] = princarg(advanced + phase[c][i] - phase[reference][i]);
                    }
                }
            }
        }

        for (int c = 0; c < channels; ++c) {
            for (int i = lowest; i <= highest; ++i) {
                m_prevInPhase`);
  await fs.writeFile(header,h);await fs.writeFile(implementation,cpp);await fs.writeFile(phaseFile,phase);
}
