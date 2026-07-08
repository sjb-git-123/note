# MyNote — 개인용 필기 웹앱

갤럭시탭(S펜)·노트북·휴대폰 브라우저에서 쓰는 1인용 손글씨 노트.
프레임워크 없이 순수 HTML/CSS/JS + Supabase + GitHub Pages로 구성.

## 파일 구성

| 파일 | 역할 |
|---|---|
| `index.html` | 로그인 / 노트 목록 / 필기 3개 화면 |
| `canvas.js` | Canvas 필기 엔진 (필압, 팜 리젝션, 지우개, Undo/Redo, 팬·핀치줌) |
| `supabase.js` | Supabase 클라이언트 + 데이터 접근 |
| `app.js` | 화면 전환, 인증, 자동 저장(2초 디바운스), 오프라인 IndexedDB 큐 |
| `style.css` | 스타일 |
| `schema.sql` | Supabase DB 스키마 (SQL Editor에서 1회 실행) |

## 최초 설정 (1회)

1. **DB 스키마**: Supabase 대시보드 → SQL Editor → `schema.sql` 내용 실행
2. **GitHub Pages**: 저장소 Settings → Pages → Branch `main` / root 선택 (완료됨)

## 사용

- 배포 주소: https://sjb-git-123.github.io/note/
- 첫 접속 시 사용할 비밀번호(6자 이상)를 정해 입력하면 계정이 만들어짐.
  이후에는 기기당 최초 1회만 같은 비밀번호 입력 (세션 유지)
- 갤럭시탭: S펜으로 필기(필압 반영), 손가락은 화면 이동/핀치줌
- 노트북: 마우스로 필기, Ctrl+휠 줌, Ctrl+Z/Y 실행취소/재실행
- 휴대폰: 손가락 필기 가능, 두 손가락 핀치줌으로 확대 열람
- 오프라인에서도 필기 가능 — 온라인 복귀 시 자동 업로드
