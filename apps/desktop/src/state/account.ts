/**
 * Tài khoản & credit. Mọi thao tác với tiền/credit đều do máy chủ thực hiện;
 * ứng dụng chỉ hiển thị số dư máy chủ trả về. Token phiên nằm trong Keychain (phía Rust).
 */
import { create } from 'zustand';
import { tauriInvoke } from '../lib/fileio';

export interface AccountUser {
  id: number;
  email: string | null;
  name: string | null;
  avatar_url: string | null;
}

interface AccountState {
  configured: boolean | null;
  reason: string | null;
  apiUrl: string | null;
  user: AccountUser | null;
  balance: number | null;
  /** tài khoản quản trị: dùng mọi tính năng không giới hạn credit */
  unlimited: boolean;
  /** giá chuyển một bản nhạc sang Editor (máy chủ quyết định) */
  editPrice: number | null;
  busy: boolean;
  loadEditPrice(): Promise<number>;
  init(): Promise<void>;
  login(): Promise<void>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
  api<T = unknown>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T>;
}

const NOT_DESKTOP = 'Tài khoản và credit chỉ dùng được trong ứng dụng desktop.';

export const useAccount = create<AccountState>((set, get) => ({
  configured: null,
  reason: null,
  apiUrl: null,
  user: null,
  balance: null,
  unlimited: false,
  editPrice: null,
  busy: false,

  async loadEditPrice() {
    try {
      const r = await get().api<{ credits: number }>('GET', '/api/v1/omr/edit-price');
      set({ editPrice: r.credits });
      return r.credits;
    } catch {
      return get().editPrice ?? 50;
    }
  },

  async init() {
    const invoke = tauriInvoke();
    if (!invoke) {
      set({ configured: false, reason: NOT_DESKTOP });
      return;
    }
    const cfg = (await invoke('account_config')) as { configured: boolean; apiUrl?: string; reason?: string };
    set({ configured: cfg.configured, reason: cfg.reason ?? null, apiUrl: cfg.apiUrl ?? null });
    if (cfg.configured) await get().refresh();
  },

  async refresh() {
    const invoke = tauriInvoke();
    if (!invoke || !get().configured) return;
    try {
      const me = (await invoke('account_me')) as { user: AccountUser; balance: number; unlimited?: boolean } | null;
      set({ user: me?.user ?? null, balance: me?.balance ?? null, unlimited: !!me?.unlimited });
    } catch {
      /* mất mạng: giữ trạng thái cũ */
    }
  },

  async login() {
    const invoke = tauriInvoke();
    if (!invoke) throw new Error(NOT_DESKTOP);
    if (!get().configured) throw new Error(get().reason ?? 'Chưa cấu hình máy chủ tài khoản');
    set({ busy: true });
    try {
      const res = (await invoke('account_login')) as { user: AccountUser; balance: number };
      set({ user: res.user, balance: res.balance });
      await get().refresh();
    } finally {
      set({ busy: false });
    }
  },

  async logout() {
    const invoke = tauriInvoke();
    if (invoke) await invoke('account_logout');
    set({ user: null, balance: null, unlimited: false });
  },

  async api<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const invoke = tauriInvoke();
    if (!invoke) throw new Error(NOT_DESKTOP);
    return (await invoke('api_request', { method, path, body: body ?? null, idempotencyKey: idempotencyKey ?? null })) as T;
  },
}));
