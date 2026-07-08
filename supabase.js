// supabase.js — Supabase 클라이언트 및 데이터 접근 계층
'use strict';

const SUPABASE_URL = 'https://anyetpykosoulymfxueq.supabase.co';
// anon 공개 키 — RLS로 보호되므로 노출 무방 (service_role 키는 절대 포함 금지)
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFueWV0cHlrb3NvdWx5bWZ4dWVxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0ODU3OTMsImV4cCI6MjA5OTA2MTc5M30.u-LL8Pk3NV6gcoHMSPxza6Aj3dp4wj7EMlWxHLLMNV0';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const DB = {
  async listNotebooks() {
    const { data, error } = await sb
      .from('notebooks')
      .select('id, title, updated_at')
      .order('updated_at', { ascending: false });
    if (error) throw error;
    return data;
  },

  async createNotebook(userId) {
    const { data, error } = await sb
      .from('notebooks')
      .insert({ user_id: userId, title: '새 노트' })
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async renameNotebook(id, title) {
    const { error } = await sb
      .from('notebooks')
      .update({ title, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
  },

  async deleteNotebook(id) {
    const { error } = await sb.from('notebooks').delete().eq('id', id);
    if (error) throw error;
  },

  async listPages(notebookId) {
    const { data, error } = await sb
      .from('pages')
      .select('id, page_number')
      .eq('notebook_id', notebookId)
      .order('page_number');
    if (error) throw error;
    return data;
  },

  async createPage(notebookId, pageNumber) {
    const { data, error } = await sb
      .from('pages')
      .insert({ notebook_id: notebookId, page_number: pageNumber })
      .select('id, page_number')
      .single();
    if (error) throw error;
    return data;
  },

  async loadPage(pageId) {
    const { data, error } = await sb
      .from('pages')
      .select('strokes')
      .eq('id', pageId)
      .single();
    if (error) throw error;
    return data.strokes;
  },

  async savePage(pageId, notebookId, strokes) {
    const now = new Date().toISOString();
    const { error } = await sb
      .from('pages')
      .update({ strokes, updated_at: now })
      .eq('id', pageId);
    if (error) throw error;
    // 노트 목록의 최종 수정일 갱신
    await sb.from('notebooks').update({ updated_at: now }).eq('id', notebookId);
  },
};
