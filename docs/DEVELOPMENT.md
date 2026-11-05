# 개발과 빌드

Windows x64와 Node.js 22.12 이상을 사용합니다. 소스를 준비한 후 저장소 루트에서 명령을 실행하세요.

## 준비 도구

- Git과 npm
- MinGW-w64의 `g++` 및 `objdump`, Windows `tar`
- GPU용 배경 제거 모델을 생성할 Python 3.9–3.12

`g++.exe`와 `objdump.exe`를 PATH에 추가합니다. 컴파일러를 직접 지정할 때는 `CXX` 환경 변수를 사용합니다. 배포 1.12의 오디오 도구는 WinLibs GCC 16.1.0·MinGW-w64 14.0.0 UCRT로 빌드했습니다. 도구 버전과 라이선스는 `resources/licenses/audio-stretch-toolchain-manifest.json`에 있습니다.

## 소스 준비

```powershell
git clone https://github.com/sssslu/sluVideoEditor.git
cd sluVideoEditor
npm ci
```

실행 파일은 `resources/bin`, 모델은 `resources/models`에 준비합니다. 아래 스크립트가 지정된 외부 배포 파일을 받고 해시를 확인합니다. 첫 준비에는 네트워크가 필요합니다.

```powershell
node scripts/prepare-ffmpeg.mjs
node scripts/fetch-whisper.mjs
node scripts/build-audio-stretch.mjs
node scripts/prepare-tracking.mjs
node scripts/collect-licenses.mjs
```

Python 3.12가 설치된 환경에서 배경 제거 모델 생성 환경을 준비합니다. 다른 지원 버전을 사용한다면 첫 명령의 `-3.12`를 해당 버전으로 바꾸세요.

```powershell
py -3.12 -m venv .build-cache/matting/onnx-env
& ./.build-cache/matting/onnx-env/Scripts/python.exe -m pip install -r scripts/matting-build-requirements.txt
$env:SLU_MODEL_PYTHON = (Resolve-Path ./.build-cache/matting/onnx-env/Scripts/python.exe).Path
node scripts/prepare-matting.mjs
```

`prepare-matting.mjs`는 원본 RVM 모델을 내려받고 DirectML 입력·출력 변환 모델을 생성합니다. 큰 ONNX 파일은 준비 스크립트로 관리합니다. 릴리스에 첨부한 1.12.0 소스 ZIP에는 검증된 모델과 의존성 소스 자료도 포함되어 있습니다. [검증된 소스 ZIP](https://github.com/sssslu/sluVideoEditor/releases/download/v1.12.0/SLU-Studio-1.12.0-source.zip)

## 실행과 패키징

```powershell
npm run build
npm start
```

개발 중에는 `npm run dev`를 사용합니다. 설치형과 포터블 생성 결과는 `release` 폴더에 저장됩니다.

```powershell
npm run package
```

자동 자막 모델과 선택적 CUDA 음성 엔진, AI 화질 향상 엔진은 앱에서 설치합니다. 미리보기와 인코더는 실행 PC에서 사용 가능한 장치를 확인합니다.

## 검사

```powershell
npm test
npm run test:integration
$env:SLU_TEST_BACKGROUND = '1'
npm run test:e2e
npm run test:captions
```

UI 검사는 별도의 프로필을 사용하고 검사 중에는 실제 영상 인코딩이 실행됩니다. 사용 중인 작업 화면과 분리해야 할 때는 `scripts/quiet-desktop.mjs`의 `launchPrivateDesktop`으로 Windows 별도 데스크톱에서 검사 프로세스를 실행합니다. 1.12 배포 검증도 이 방법을 사용했습니다.

검사 범위와 관측한 성능은 버전별 기록에서 확인할 수 있습니다. [검증 기록](검증결과.md)

## 코드 위치

- `src`에 편집 UI, 타임라인과 WebGL 미리보기가 있습니다.
- `shared`에 프로젝트 형식, 편집 계산과 입력 검증이 있습니다.
- `electron`에 파일 처리, 인코딩과 AI 작업 관리가 있습니다.
- `native`에 오디오 처리 도구와 AI 작업 코드가 있습니다.
- `tests`와 `scripts`에 검사 및 준비 도구가 있습니다.

앱 코드는 GPL-3.0-or-later이며 의존성의 고지·원본 소스·패치 자료는 `resources/licenses`에 있습니다. [앱 라이선스](../LICENSE) · [의존성 자료](../resources/licenses)
