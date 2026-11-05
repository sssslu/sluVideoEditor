# -*- coding: utf-8 -*-
from pathlib import Path
import json, re
root = Path(__file__).resolve().parent.parent
def read(name):
    return json.loads((root / name).read_text(encoding='utf-8-sig'))
version = read('package.json')['version']
validation = read(f'.test-artifacts/verification-{version}.json')
def source_ui(name):
    return json.loads((Path(validation['evidenceDirectory']) / name / 'results.json').read_text(encoding='utf-8'))
captions = validation['richCaptions']
color = validation['color']
caption_ui = source_ui('captions-ui')
caption_benchmark = next(item for item in captions['benchmark']['details'] if item['kind'] == 'rich-captions')
caption_baseline = next(item for item in captions['benchmark']['details'] if item['kind'] == 'blank-baseline')
caption_cache = next(item for item in caption_benchmark['events'] if item['event'] == 'caption-renderer-close')
caption_gpu = next(item for item in captions['preview']['details'] if item['mode'] == 'gpu')
transitions = validation['transitions']
transition_ui = source_ui('transitions-ui')
transition_jobs = source_ui('transition-jobs')
source_revision = source_ui('source-revision/ipc')
source_async = source_ui('source-async')
range_results = read('.test-artifacts/video-range/results.json')
transition_review = read('.test-artifacts/transition-review/results.json')
transition_edit_ms = next(item['disconnectedEditMs'] for item in transition_review['timings'] if item['clips'] == 10000)
transition_names = {'dissolve':'디졸브','wipe':'와이프','slide':'밀어내기','zoom':'줌'}
transition_benchmark_rows = '\n'.join(f"| {transition_names[item['kind']]} | {'OpenCL GPU' if item['transitionBackend'].startswith('opencl') else 'CPU'} | {item['seconds']:.3f}초 |" for item in transitions['benchmark'])
if validation['version'] != version or validation['unit']['fail'] or validation['unit']['cancelled']:
    raise ValueError('Current-version verification did not pass')
speed_ui = source_ui('speed-curve')
stabilization_ui = source_ui('stabilization-ui')
job_ui = source_ui('job-locks-ui')
speed_video = read('.test-artifacts/speed-render/video-results.json')
speed_audio = read('.test-artifacts/speed-render/audio-results.json')
speed_long = read('.test-artifacts/speed-render/continuous60-results.json')
audio_timing_error = max(abs(mark['error']) for case in speed_audio if case['name'] != 'zigzag' for mark in case['landmarks'])
audio_pitches = [pitch for case in speed_audio if case['name'] != 'zigzag' for pitch in case['pitches']]
ui = source_ui('editor-v2')
ipc = source_ui('ipc-v2')
stress = read('.test-artifacts/render-stress/results.json')
cuda = read('.test-artifacts/render-stress/cuda-results.json')
final_metrics = read('.test-artifacts/render-stress/final-metrics.json')
preview = read('.test-artifacts/gpu-preview/results.json')
stabilization = read('.test-artifacts/stabilization/results.json')
stabilization_timing = read('.test-artifacts/stabilization/timing-results.json')
stabilization_repeats = read('.test-artifacts/stabilization/repeat-results.json')
comparison = final_metrics['previewComparison']
comparison = comparison['value'] if isinstance(comparison, dict) else comparison
blur = next(item for item in comparison if item['variant'] == 'blur')
nonblur = [item['meanAbsoluteRgbError'] for item in comparison if item['variant'] != 'blur']
node_peak = max([stress['peakNodeRssBytes']] + [item['nodeRss'] for item in stress.get('samples', [])])
gpu_rows = []
for item in preview['performance']:
    label = f"{item['layers']}×720p 프록시" if item['proxy'] else f"{item['layers']}×4K 원본"
    if item['layers'] == 10 and not item['proxy']:
        label += ' — 과부하'
    stats = item['stats']
    lag = max(sample['maxSourceLagSeconds'] for sample in item['samples'])
    gpu_rows.append(f"| {label} | {stats['fps']:.2f} | {lag:.3f}초 | {item['missed']} | {stats['renderMs']:.3f} / {stats['p95Ms']:.3f}ms |")
gpu_rows = '\n'.join(gpu_rows)
cuda_labels = {'cuda-cold':'CUDA 최초 실행', 'cpu':'CPU 전처리', 'cuda-warm':'CUDA 초기화 후', 'cpu-repeat':'CPU 전처리 재실행', 'cuda-repeat':'CUDA 재실행'}
cuda_rows = '\n'.join(f"| {cuda_labels[item['label']]} | {item['seconds']:.3f}초 | {item['renderFps']:.2f} |" for item in cuda['runs'])
boundary = read('.test-artifacts/render-v2/boundary-results.json')
speech = read('.test-artifacts/services/speech-upgrade-results.json')
rows = '\n'.join(f"| {r['model']} | {r['name']} | {r['seconds']:.3f}초 | {len(r['cues'])} |" for r in speech['results'] if 'model' in r)
report = f'''# SLU Studio {version} 검증 기록

검증 환경: Windows x64, Ryzen 7 9800X3D, RAM 32GB, RTX 4080 SUPER 16GB, 드라이버 591.86. Electron 45.1.0, FFmpeg 8.0.1. 2026-10-30 실행 결과입니다.

{version} 소스 빌드·통합 검사 통과. 기본 테스트 {validation['unit']['tests']}개 중 {validation['unit']['pass']}개 통과·선택형 {validation['unit']['skipped']}개 건너뜀, 실패 0개입니다. 실제 앱의 편집·저장·출력·복구 검사 {validation['uiChecks']}개를 통과했습니다. 이 문서는 소스 빌드 검사 기록이며, 배포 EXE의 별도 실행·무결성 결과는 `release/BUILD-INFO.json`에 기록합니다. 아래 GPU 미리보기·66초 출력·CUDA 직접 경로·CUDA 음성 인식의 성능 수치는 이전 1.1 검증에서 수집한 비교 기록입니다.

UI 자동 검사는 사용자 작업을 가리지 않도록 격리된 숨김 창에서 실행했습니다. Electron45/이 Windows 환경의 숨긴 창이 1fps로 제한되는 현상을 재현했고, UI 검사 실행기에만 `--disable-frame-rate-limit`을 전달했습니다. UI 검사 시간은 성능 수치로 사용하지 않으며 아래 별도 출력 벤치마크에는 이 인수를 사용하지 않았습니다.

연속 저장에서 경로 확인이 늦은 이전 요청이 최신 파일을 덮는 경합을 수정했습니다. 수동 저장은 검증·경로 선택·원자적 쓰기까지 요청 순서대로 처리하며 종료 시 대기합니다. 실제 IPC에서 첫 경로 확인을 500ms 지연시켜도 최신 요청이 남는 것을 확인했습니다. 실패한 저장이 이후 저장을 막지 않는 검사도 포함합니다.

## 1.5 색 보정과 스코프

전체·R/G/B 곡선, 3D .cube LUT와 강도·적용 전후 비교를 구현했습니다. LUT를 프로젝트에 포함하며 잠금·다중 선택·복사·실행 취소·저장 후 원본 LUT 이동을 실제 UI로 검사했습니다. 미리보기는 WebGL2, 출력의 색 보정은 FFmpeg CPU 필터이며 인코딩은 별도로 NVENC를 사용할 수 있습니다.

- 실제 FFmpeg 출력 {len(color['render']['results'])}종의 최대 채널 오차 {max(item['max'] for item in color['render']['results'])}/255. 33³·65³ LUT, 입력 도메인, 강도 0·우회, 알파 보존을 포함합니다.
- WebGL2·CPU 미리보기 {len(color['pixels']['details'])}개 비교에서 최대 채널 오차 {max(item['max'] for item in color['pixels']['details'])}/255. 실제 내보내기 창에서 만든 NVENC 영상 {color['ui']['exportPixels']['frames']}프레임의 기준 대비 평균 YUV 차이는 {color['ui']['exportPixels']['mean']:.4f}/255였습니다. 표본 결과이며 모든 영상의 오차 상한을 뜻하지 않습니다.
- 색 보정 UI {len(color['ui']['checks'])}개와 스코프 UI {len(color['scopes']['checks'])}개 통과. 스코프는 히스토그램·파형·RGB 퍼레이드·벡터스코프를 지원하며 최대 320×180, 초당 8회, 작업 하나로 제한합니다. 정지 중 색 변경·빠른 탐색·프로젝트 교체의 오래된 결과 폐기·소스 화면 전환·실제 GPU 컨텍스트 소실 후 CPU 전환을 검사했습니다.

스코프는 현재 합성 화면의 SDR 표본이며 전체 해상도/HDR 측정 도구가 아닙니다. HSL, Log/HDR 컬러 관리와 사용자 효과 체인은 미구현입니다. 프로젝트 형식 5는 LUT를 내장하며 이전 형식 1–4를 읽습니다. 이전 앱은 형식 5를 읽을 수 없습니다.

## 자막과 단어 시간

Whisper의 실제 단어 시간을 UTF-16 문자열 구간과 함께 보존합니다. 측정·수동·균등 추정 시간을 구분하며, 단어를 선택해 시작/끝 또는 현재 재생 위치로 수정할 수 있습니다. 글자를 바꾸면 기존 단어 연결을 지우고 실행 취소로 함께 복구합니다. 분할·트리밍·속도 커브의 시간 변환, 트랙 잠금, 스타일 일괄 적용, 저장 후 다시 열기를 포함한 실제 자막 UI {len(caption_ui['checks'])}개 검사를 통과했습니다.

새 자막은 번들 Noto Sans KR·Noto Color Emoji와 공통 Canvas 래스터를 사용합니다. 줄 배경·둥근 모서리·외곽선·그림자·자간·굵기·줄 높이·단어 강조·등장/퇴장 효과와 24개 사용자 스타일 저장을 지원합니다. 지원하지 않는 글자는 알리고 출력을 중단합니다. 임의의 사용자 폰트나 모든 문자·이모지 조합을 지원한다고 주장하지 않습니다. 기존 ASS 자막은 별도 경로를 유지합니다.

- 30·60·120fps와 세로/축소 출력의 원시 RGBA 70개 비교, 분할 중인 단어·애니메이션 시계, 기존 ASS와 새 자막의 겹침 순서, 출력 구간 경계와 취소 검사를 통과했습니다.
- 실제 120fps 출력 {captions['preview']['details'][0]['frames']}프레임과 CPU 미리보기를 동일 BT.709 4:2:0 변환 후 비교하면 바이트가 같습니다. WebGL 미리보기의 최대 프레임 평균 오차는 {caption_gpu['maximumMean']:.4f}/255, 자막 영역 밝기 평균 오차는 최대 {caption_gpu['maximumInkMean']:.4f}/255입니다. 이 값은 해당 장면의 측정 결과입니다.
- Canvas/WebGL의 27개 스타일·정렬·강조 상태에서 최대 평균 RGB 차이는 {captions['raster']['maxMean']:.5f}/255였습니다. 자막 래스터 캐시 48MiB·32개, 레이아웃 96개·20만 문자, 출력 프레임 재사용 캐시 64MiB 제한을 검사했습니다.
- 작은 창에서도 자막 목록 높이 86px를 확보하고 단어 시간·현재 위치·스타일 저장 버튼의 실제 클릭 가능 여부를 검사했습니다. 프로젝트 120fps 표시와 기존 효과의 표시/변경/실행 취소도 포함합니다.
- 테스트의 로그 연결 종료로 발생했던 EPIPE 오류를 재현했습니다. 테스트 실행기는 로그 파일과 자식 프로세스를 소유하고, 로그 또는 부모 연결 종료 시 창 0개로 정리되는 것을 확인했습니다.

4K30·2초·60프레임의 합성 자막 표본에서 빈 화면 출력 {caption_baseline['seconds']:.3f}초, 자막 출력 {caption_benchmark['seconds']:.3f}초였습니다. 자막 합성과 일반 영상 합성은 CPU, 인코딩은 NVENC입니다. {caption_cache['renderedFrames']}개 상태만 래스터화하고 {caption_cache['reusedFrames']}프레임을 재사용했습니다. 출력 캐시 측정 최대 {caption_cache['peakCacheBytes']/1024**2:.2f}MiB, 프로세스 간 RGBA 전송량 {caption_cache['transferredBytes']/1024**2:.2f}MiB입니다. 짧은 합성 표본이며 일반 영상 프로젝트의 속도를 뜻하지 않습니다.

저장/복구 파일은 50MiB, 단어 정보는 자막당 2,048개·프로젝트 전체 20만 개입니다. 같은 출력 구간에 섞인 새 자막/기존 ASS 그룹의 RGBA 프레임 합계가 256MiB를 넘으면 명확한 오류로 중단합니다. SRT에는 문구와 문장 시간만 저장됩니다.

## 1.3에서 추가한 전환과 원본 갱신

디졸브·와이프·밀어내기·줌, 네 방향(와이프·밀어내기), 진행 곡선과 선형·이퀄 파워·없음 오디오를 지원합니다. 클립 자체의 시작·길이·페이드·속도 커브를 바꾸지 않고 컷 앞뒤의 원본 여유 구간을 사용합니다. 전환 길이는 프로젝트 프레임 단위이며 출력 프레임률과 독립적입니다. 복사 후 프레임률을 바꿔 붙여넣어도 전환 시간을 가장 가까운 새 프레임으로 유지합니다.

실제 전환 UI {len(transition_ui['checks'])}개, 비동기 분석·취소 {len(transition_jobs['checks'])}개, 원본 교체·재연결 {len(source_revision['checks'])}개 검사를 통과했습니다. 잠금, 실행 취소, 두 클립 복제, 캔버스 선택·줌 드래그, 저장 후 다시 열기, 같은 프로젝트 ID를 다시 연 뒤 도착하는 오래된 결과를 포함합니다. 전환에 원본 여유가 부족하거나 다른 클립·전환이 겹치면 적용을 거부합니다.

원본·프로젝트 비동기 경계 {len(source_async['checks'])}개 검사는 실행 취소가 교체 전 원본 정보·프록시를 되살리지 않는지, 오래된 프록시·자막·보정 결과가 현재 프로젝트에 들어오지 않는지, 지연된 열기·저장 완료가 새 프로젝트와 저장 경로를 덮어쓰지 않는지 확인했습니다. 처리 도중 실제 원본을 바꾸는 별도 검사에서 두 자막 엔진과 흔들림 보정 모두 결과를 게시하지 않았습니다.

- 실제 Electron WebGL2/Canvas2D에 현재 소스 렌더러를 넣어 {transitions['pixelCases']}개 장면·{transitions['pixelComparisons']}개 픽셀 비교를 수행했습니다. 불투명·반투명·변형 효과와 네 방향, 경계 시점을 포함하며 최대 장면별 평균 오차는 기준식 대비 {transitions['maximumReferenceMean']:.3f}/255였습니다. 실제 앱의 번들 UI 검사는 위 흐름 검사에 별도로 포함됩니다.
- FFmpeg 전환 합성 {transitions['graphCases']}개 장면의 최대 채널 오차는 기준식 대비 {transitions['maximumGraphError']}/255였습니다. 반투명 입력은 먼저 한 쌍으로 합성한 후 아래 트랙 위에 올리므로 디졸브 중 배경이 중복 비치지 않습니다.
- 네 전환 각각 {transitions['parity'][0]['frames']}프레임에서 1초·6초 출력 구간의 영상 바이트가 일치했습니다. 전환 밖 {transitions['parity'][0]['outsideFramesUnchanged']}프레임과 전환 제거 후의 출력도 기존 결과와 같았습니다. 30fps 프로젝트의 24fps 출력, 프레임에 맞지 않는 컷, 페이드·마스크·변형 키프레임을 포함합니다. 실제 영상·속도 커브 입력도 {transitions['video']['frames']}프레임의 구간별 바이트가 같았습니다.
- 세 오디오 모드의 최대 샘플 오차는 기준 게인 계산 대비 {max(item['maximumSampleError'] for item in transitions['audio']):.2g}였습니다. 4096·777샘플 읽기 단위에서 PCM이 같고, 두 소스를 각 한 번씩 연속 디코딩했습니다. 원래 64개 제어점을 보존한 속도 커브의 앞뒤 0.5초 연장 검사에서 최대 시각 오차는 {max(abs(item['error']) for item in transitions['curve']['landmarks'])*1000:.3f}ms였으며 취소 후 남은 프로세스는 0개였습니다.
- 10,000개 클립·9,999개 전환에서 여러 컷을 끊는 편집의 연결 갱신은 {transition_edit_ms:.1f}ms였습니다. 전체 UI 반응 시간이 아닌 연결 갱신 함수 한 번의 측정입니다. 500개 무작위 원본·컷 조건을 별도의 프레임별 계산과 비교했습니다.

영상보다 오디오가 긴 파일, 지연 시작, VFR, 회전·편집 목록 등 실제 영상 범위 {len(range_results['results'])}개 샘플을 검사했습니다. 불명확한 원본은 필요할 때 프레임을 분석하고 취소할 수 있습니다. 원본 파일이 같은 경로에서 교체되면 이전 프록시·썸네일·디코더를 갱신합니다. 다시 열기에서 여유 구간이 사라진 전환은 해제하고 알리며 기존 프로젝트 파일은 그대로 둡니다. 내보내기는 연결된 원본이 바뀌었는지도 다시 확인합니다.

밀어내기·줌 출력은 실제 장치 검사를 통과하면 OpenCL GPU에서 16비트 평면·투명도와 FP64 좌표를 사용합니다. 나머지 클립 효과·일반 합성이 모두 GPU로 옮겨진 것은 아닙니다. 디졸브·와이프는 CPU의 최적화된 혼합 경로를 사용합니다. 출력의 **전환 처리 → CPU**는 GPU 인코더 선택과 독립적이며 GPU 전환이 실패하면 전체 출력을 새 스트림으로 CPU 재시도합니다.

GPU 전환 기준 픽셀 {transitions['gpu']['pixelCases']}개 장면과 밀어내기·줌 각각 96프레임의 1초·6초 구간 검사를 통과했습니다. 같은 GPU 경로의 구간 간 바이트는 같았고, CPU 대비 최대 차이는 {max(item['maximumCpuDifference'] for item in transitions['gpu']['windows'])}/255, 장면별 평균은 최대 {max(item['meanCpuDifference'] for item in transitions['gpu']['windows']):.6f}/255였습니다. 전환 밖 프레임은 같았습니다. GPU 프레임이 이미 전달된 다음 고의로 실패시킨 검사에서 CPU 재시도 영상·오디오는 CPU 기준과 같고 중복 프레임이 없었습니다. 실행 중 취소 후 자식 프로세스와 게시된 출력은 0개였습니다. 다른 GPU·드라이버의 동일 성능은 검증하지 않았습니다.

아래 전환 성능 표는 1.3 소스에서 측정한 비교 기록이며, 현재 기능 회귀 검사와 구분합니다. 1920×1080·30fps·4초·120프레임, 컷의 1초 전환과 타원 마스크·크기·회전·불투명도를 적용한 두 이미지의 출력 시간입니다. 인코딩은 네 경우 모두 H.264 NVENC이며, 전환 이외 효과는 CPU에서 처리합니다. 출력 함수 호출부터 완료까지 측정했으며 입력 생성·초기 미디어 정보 분석·인코더 지원 검사는 제외합니다. 짧은 이미지 표본이므로 긴 영상 프로젝트나 다른 효과의 속도로 일반화하지 않습니다.

| 전환 | 전환 계산 | 전체 출력 시간 |
| --- | --- | ---: |
{transition_benchmark_rows}

기존 ASS 자막은 30·60·120fps 실제 픽셀에서 문구 존재를 검사했고, 120fps 출력 {validation['captionTiming']['frames']}프레임의 1초·6초 구간이 같았습니다. 이 경로에는 ASS의 1/100초 시간 해상도와 미리보기/출력 표현 차이가 남습니다. 위의 새 자막 경로와 구분합니다.

## 1.2에서 추가한 속도 커브와 흔들림 보정

영상·오디오의 속도 커브는 제어점 사이를 선형 보간하고 원본 시각은 속도를 적분해 계산합니다. 그래프 드래그·점 추가/삭제·위치와 속도 숫자 입력·5개 프리셋을 지원합니다. 속도 변경은 원본 시작·끝을 유지하며 타임라인 길이를 `원본 구간 ÷ 평균 속도`로 바꿉니다. 분할·트리밍은 남은 구간의 시각 연결을 유지하고, 이웃 클립·별도 자막은 자동 이동하지 않습니다. 광학 흐름 프레임 생성은 없습니다.

속도 UI {len(speed_ui['checks'])}개 검사는 그래프·숫자 입력·분할·트리밍·실제 디코더 탐색·저장 후 다시 열기와 MP4 출력을 포함합니다. 1초·6초 출력 구간에서 영상 {speed_video['frames']}프레임의 해시가 일치했습니다. 오디오는 Rubber Band R3의 연속 위상 상태를 유지하고 분석 단계마다 원본 시각의 역함수를 적용합니다. 5개 일정/변화 속도 합성 음원에서 최대 시각 오차 {audio_timing_error*1000:.3f}ms, 440Hz 음원의 측정 음정 {min(audio_pitches):.2f}–{max(audio_pitches):.2f}Hz였습니다. PCM 샘플 수·출력 구간 간 바이트 일치·MP4 영상/음성 싱크·분할·취소 정리도 검사했습니다.

60초·33개 제어점의 스테레오 합성 음원은 {speed_long['renderSeconds']:.3f}초에 처리되었습니다. 네이티브 작업 집합 표본 최대 {speed_long['peakNativeWorkingSetBytes']/1024**2:.2f}MiB, JS PCM 버퍼 최대 {speed_long['peakBufferBytes']/1024:.1f}KiB였습니다. 기존 독립 처리 구간의 주기적 음량 저하를 없앴고 경계/일반 구간의 최소 RMS 비율은 {speed_long['boundaryVsOrdinaryMinimum']:.4f}였습니다. 이 값은 합성 음원 검사이며 일반 음악의 청감 품질 점수가 아닙니다. 영상보다 늦게 시작하거나 중간에 비는 오디오도 일정/커브 배속과 원본 트리밍 조합에서 위치·무음을 유지했습니다.

**남은 음질 제한:** 8초에 64개 제어점으로 0.1↔16배를 약 127ms마다 반복하는 극단적인 입력에서는 440Hz 음원의 일부 짧은 구간에 최대 +5.5Hz(21.5센트) 음정 흔들림이 측정되었습니다. 이 조건의 정확한 샘플 수·타이밍과 별개로 음정 보존은 완전하지 않으며, 일반 속도 검사 통과로 해당 제한을 숨기지 않습니다.

흔들림 보정은 CPU의 FFmpeg libvidstab 2패스로 선택 원본 구간을 처리합니다. 원본은 보존하고 사용자 데이터 폴더의 `media-derived`에 별도 H.264 CRF16 + PCM MOV를 저장합니다. 적용·해제 시 속도 커브와 효과를 유지하며 트리밍 후 해제도 원본의 해당 구간으로 돌아갑니다. 8비트 SDR 불투명 영상만 지원하고 HDR·고비트·투명 영상은 거부합니다. 자동 확대는 가장자리를 자르며 영상 재인코딩은 무손실이 아닙니다.

합성 흔들림 샘플의 위치 분산은 {stabilization['translationVarianceBefore']:.3f} → {stabilization['translationVarianceAfter']:.6f}로 {stabilization['reductionPercent']:.3f}% 감소했습니다. {stabilization['frames']}프레임과 PCM {stabilization['audioSamples']:,}샘플을 유지했고 오디오는 바이트 단위로 일치했습니다. 동일 입력 {len(stabilization_repeats['repeats'])}회에서 디코딩 RGB·분석 파일 해시가 모두 같았으며 Chromium에서 MOV 영상·음성 재생을 확인했습니다. VFR {stabilization_timing['vfrFrames']}프레임, 최대 시각 오차 {stabilization_timing['vfrMaxTimestampError']*1000:.3f}ms, 지연 오디오·회전·비정사각 픽셀과 두 패스 취소 정리도 검사했습니다. 합성 이동 샘플의 결과로 실제 카메라 영상 전반의 품질 점수는 아닙니다.

이전 프로젝트를 현재 앱에서 저장하면 형식 5가 되므로 이전 앱에서도 사용할 파일이 필요하면 다른 이름으로 저장해야 합니다.

흔들림 보정 실제 UI {len(stabilization_ui['checks'])}개와 작업 완료·트랙 잠금 검사 {len(job_ui['checks'])}개를 통과했습니다. 원본 참조가 삭제된 클립의 붙여넣기, 잠긴 자막 수정, 잠긴 클립의 다중 페이드 적용을 차단하며 오래된 비동기 결과가 다른 프로젝트나 수정된 원본 구간을 덮어쓰지 않습니다. 영상 다운로드 UI·IPC·처리 코드와 새 배포 포함 목록에서 관련 기능을 제거했습니다.

## 기존 편집 검사

- 새 편집 UI {len(ui['checks'])}개 흐름 통과, JavaScript 오류 0건.
- 소스 I/O, 삽입·덮어쓰기, 포인터 이동·트리밍, 다중 선택, 키프레임 보간, 마스크·크로마키, 250% 게인, 트랙 조작, 인라인 자막, 복구 기록을 실제 Electron에서 조작했습니다.
- 클립 10,000개 프로젝트의 전체 보기에서 클립 요소 {ui['counts']['clips']}개, 눈금 {ui['counts']['ticks']}개를 렌더링했습니다. 자막 10,000개 목록과 깊은 스크롤도 검사했습니다.
- 1100×720 최소 창 크기에서 조작 영역이 화면 안에 있는지 확인했습니다.
- 추가 UI 검사: 실제 영상 출력, SRT 가져오기·저장, CPU 자동 자막, 배속·트리밍 자막 매핑, 프록시, 마지막 수정 직후 종료·복구.
- IPC 검사 {len(ipc['checks'])}개 통과. 미디어 정보는 {ipc['metadataReturnMilliseconds']:.1f}ms 후 반환되었고 썸네일·파형은 배경 작업 이벤트로 도착했습니다. 해당 12초 샘플 한 건의 수치입니다.

## 출력 경계와 메모리

같은 8.3초 프로젝트를 1초·6초 구간으로 나눠 렌더링했습니다. 1.27배속, 프레임에 맞지 않는 원본 시작점, 비선형 키프레임, 움직이는 한국어 자막, 겹치는 오디오를 포함합니다. **{boundary['frames']}개 프레임의 해시가 모두 일치**했고 PCM 오디오도 바이트 단위로 일치했습니다.

| 항목 | 1080p 다중 클립 출력 |
| --- | ---: |
| 타임라인 길이 | {stress['duration']:.3f}초 |
| 클립 | {stress['clips']}개 (영상 {stress['videoClips']}개) |
| 출력 | 1920×1080, 30fps, H.264 NVENC |
| 실제 프레임 | {stress['frames']}개 |
| 걸린 시간 | {stress['elapsedSeconds']:.3f}초 |
| FFmpeg 작업 집합 합계 최대 | {stress['peakFfmpegWorkingSetBytes']/1024**2:.1f} MiB |
| Node RSS 기록 최대 | {node_peak/1024**2:.1f} MiB |
| 동시 FFmpeg 프로세스 최대 | {stress['peakFfmpegProcesses']}개 |
| 작업 후 남은 프로세스 | {len(stress['orphanPids'])}개 |

메모리는 주기적으로 표본 수집했으며 공유 페이지를 중복 합산할 수 있습니다. VRAM 수치가 아닙니다. 원시 영상의 중간 파일 없이 구간별 합성 결과를 하나의 인코더로 전달합니다. 영상·오디오 전달 버퍼의 측정 최대치는 각각 {stress['metrics']['peakVideoBufferBytes']/1024:.0f} KiB와 {stress['metrics']['peakAudioBufferBytes']/1024:.0f} KiB였습니다. 출력 취소 후 임시 파일과 소유 프로세스가 남지 않는지 검사했습니다.

## CUDA 직접 출력 경로

NVENC 출력에서 조건에 맞는 영상 한 개는 CUDA 디코딩·크기 조절 뒤 GPU 메모리에서 바로 인코딩합니다. 클립이 처음부터 전체 구간을 덮고, 원본 시작점 0·1배속·불투명·효과/자막/키프레임 없음·출력과 같은 종횡비·정사각 픽셀·회전 메타데이터 없음·출력 프레임 경계에 맞는 길이여야 합니다. BT.709 원본(태그 없는 HD의 BT.709 추정 포함)과 실제 CUDA 디코딩 검사를 통과한 코덱만 사용하며, 일반 합성은 CPU에서 처리하고 일부 기본 영상의 디코딩·크기 조절만 CUDA로 가속합니다.

아래는 **1080p 30fps 원본 → 4K 60fps, 3초·180프레임** 출력입니다. 두 경로 모두 최종 인코더는 H.264 NVENC이며 ‘CPU 전처리’는 CPU 인코딩을 뜻하지 않습니다. 최초 CUDA 실행에는 지원 여부 검사 시간이 포함됩니다.

| 전처리 경로 | 걸린 시간 | 출력 처리 fps |
| --- | ---: | ---: |
{cuda_rows}

CUDA/CPU 출력의 320×180 비교에서 RGB 평균 절대 오차는 {cuda['meanAbsoluteRgbErrorAt320x180']:.4f}/255였고, 디코딩한 PCM 오디오는 동일했습니다. 짧은 샘플의 결과이므로 모든 프로젝트에서 같은 속도 향상을 보장하지 않습니다.

## GPU 미리보기

실제 WebGL2/ANGLE·RTX 4080 SUPER에서 1280×720 합성을 측정했습니다. 5개 원본과 10개 프록시는 약 5초, 10개 원본은 약 7초 동안 재생했으며, 편집기 React 콜백 대신 측정 콜백을 연결한 미리보기 런타임 검사입니다.

| 입력 | 합성 fps | 최대 소스 지연 | 합성 누락 프레임 | GL 제출 평균 / P95 |
| --- | ---: | ---: | ---: | ---: |
{gpu_rows}

**합성 fps는 원본 디코딩 fps가 아닙니다.** 소스 지연은 재생 시각과 `requestVideoFrameCallback`으로 확인한 영상 프레임 시각의 차이입니다. 4K 원본 10개는 디코딩이 멈춰 뒤처졌으며, 0.5초 초과 지연이 1.5초 지속되면 자산당 한 번 프록시 안내를 표시했습니다. 과부하 행의 낮은 제출 시간에는 새 원본 프레임이 준비되지 않은 상태도 포함됩니다. GL 제출 시간은 CPU가 명령을 전달한 시간이며 GPU 실행 시간은 측정하지 않았습니다.

크롭·반전·회전·크로마키·마스크·종횡비·연속 탐색의 픽셀 검사를 통과했고 GL 오류는 0건, 두 탐색 지점의 원본 시각 오차는 {preview['maxSeekErrorSeconds']:.3f}초였습니다. 실제 WebAudio RMS 측정에서 250% 게인의 배율은 {preview['audio']['ratio']:.3f}였고 GPU 컨텍스트 손실 후 360p CPU 대체 경로도 검사했습니다.

320×180 미리보기와 인코딩 출력의 RGB 평균 절대 오차는 기본·반전·회전·크롭·크로마키·마스크에서 {min(nonblur):.2f}–{max(nonblur):.2f}/255였습니다. 블러 8은 GPU의 가우시안 근사와 경계 처리 차이로 평균 {blur['meanAbsoluteRgbError']:.2f}/255, RMS {blur['rgbRmsError']:.2f}/255였으며 픽셀이 완전히 같지는 않습니다.

## 자동 자막

CUDA 백엔드 활성화를 실행 로그에서 확인했습니다. 아래는 초기 실행 후 재측정한 값입니다. 최초 CUDA 실행은 초기화 때문에 더 오래 걸렸습니다.

| 모델 | 샘플 | 처리 시간 | 자막 수 |
| --- | --- | ---: | ---: |
{rows}

한국어 샘플은 9.69초의 합성 음성, 영어는 약 11초의 공개 연설입니다. 일반 음성 정확도 평가가 아닙니다. 선택 구간의 시간 범위, 글자 수·길이 제한, 인식 중 취소와 임시 파일 정리도 검사했습니다. 모델·엔진은 해시를 검증해 설치합니다.

## 저장과 파일 처리

- 프로젝트별 복구본, 겹쳐 실행한 저장의 순서, UTF-8 BOM 프로젝트 열기를 검사했습니다.
- Windows에서 대상 파일을 650ms 동안 독점 잠금한 상태에서도 원자적 저장이 재시도 후 완료되었습니다. 기존 파일을 먼저 삭제하지 않습니다.
- 폴더 연결(junction)로 경로가 달라져도 원본 미디어 덮어쓰기를 거부합니다.

## 제한과 미검증 범위

CapCut과 기능이 동등하지 않습니다. AI 배경 제거, 물체 추적, 광학 흐름, 멀티캠, 중첩 시퀀스, 협업, 템플릿 마켓은 없습니다.

출력의 동시 영상·이미지 입력과 오디오 입력은 각각 최대 32개이며 텍스트는 별도로 처리합니다. 미리보기는 활성 미디어 입력 합계 최대 32개입니다. 클립 10,000개는 계획기/UI 검사이고 장시간 출력 비교 기록은 50개 클립·66.562초입니다. 8비트 SDR을 대상으로 하며 HDR 톤 매핑은 없고, ASS의 1/100초 시간 단위와 Canvas 글자 렌더링 때문에 자막 표현에도 차이가 있습니다. 출력 구간 사이에는 `atempo` 상태를 유지하지만, 배속 클립을 별도 클립으로 분할했을 때 독립 `atempo` 인스턴스의 위상·과도음까지 같다고 보장하지 않습니다.

다른 PC, 수 시간 분량의 복잡한 출력, 실제 설치형 프로그램 설치 절차는 검증하지 않았습니다. 포터블과 설치형은 Windows 코드 서명이 없습니다.

## 재현

```powershell
npm run build
npm test
npm run test:integration
npm run test:e2e
node scripts/e2e-color-pixels.mjs
npm run test:captions
node scripts/e2e-caption-output-preview.mjs
node scripts/test-rich-captions.mjs --benchmark
npx tsx scripts/check-caption-words.ts
node scripts/e2e-transition-pixels.mjs
node scripts/video-range-integration.mjs
npx tsx scripts/transition-review.ts
npx tsx --test tests/stabilization.test.ts
npx tsx scripts/stabilization-integration.ts
node tests/preview-gpu.mjs
$env:SLU_STRESS='1'
$env:SLU_GPU_BENCH='1'
$env:SLU_PREVIEW_COMPARE='1'
npx tsx --test tests/render-stress.test.ts tests/render.test.ts
$env:SLU_TEST_CUDA='1'
$env:SLU_TEST_TURBO='1'
npx tsx scripts/speech-integration.ts
```

개발 증거는 `.test-artifacts` 아래 `editor-v2`, `e2e`, `e2e-additional`, `ipc-v2`, `render-v2`, `render-stress`, `gpu-preview`, `speed-curve`, `speed-render`, `stabilization`, `stabilization-ui`, `services`, `portable`에 저장됩니다. 원본 결과 파일은 실행 패키지에 포함하지 않습니다.
'''
(root / 'docs/검증결과.md').write_text(report,encoding='utf8')
print('Verification report updated from actual result files')
