-- MyNote 필기앱 DB 스키마
-- Supabase 대시보드 → SQL Editor 에서 이 파일 전체를 실행하세요.

-- 노트 목록
create table notebooks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users not null,
  title text not null default '새 노트',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 페이지 (노트 1개 = 페이지 여러 장)
create table pages (
  id uuid primary key default gen_random_uuid(),
  notebook_id uuid references notebooks on delete cascade not null,
  page_number int not null,
  strokes jsonb not null default '[]',
  updated_at timestamptz default now(),
  unique (notebook_id, page_number)
);

-- RLS: 본인 데이터만 접근 가능
alter table notebooks enable row level security;
alter table pages enable row level security;

create policy "own notebooks" on notebooks
  for all using (auth.uid() = user_id);

create policy "own pages" on pages
  for all using (
    notebook_id in (select id from notebooks where user_id = auth.uid())
  );
