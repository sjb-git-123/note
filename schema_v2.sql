-- v2: 텍스트 검색 + 책갈피
-- Supabase 대시보드 → SQL Editor 에서 이 파일 전체를 실행하세요.

alter table pages add column if not exists text_content text not null default '';
alter table pages add column if not exists bookmarked boolean not null default false;
