import { useEffect, useState } from 'react';
import { useAccount } from '../state/account';
import { useStore } from '../state/store';
import { tauriInvoke } from '../lib/fileio';
import { IconCoin, IconUser } from './icons';

interface Tx { id: number; amount: number; balance_after: number; type: string; note: string | null; created_at: string }

const TYPE: Record<string, string> = {
  signup_bonus: 'Quà tài khoản mới', purchase: 'Nạp credit', ai_charge: 'Dùng AI', ai_refund: 'Hoàn credit AI',
  admin_adjustment: 'Điều chỉnh', reversal: 'Đảo giao dịch',
};

export function AccountMenu() {
  const acc = useAccount();
  const notify = useStore((s) => s.notify);
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<Tx[] | null>(null);

  useEffect(() => {
    void acc.init();
    const t = setInterval(() => void useAccount.getState().refresh(), 60_000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const login = () => acc.login().then(() => notify('Đăng nhập thành công')).catch((e) => notify(String(e.message ?? e), 'error'));
  const buy = () => {
    const base = acc.apiUrl?.replace(/\/api.*$/, '') ?? '';
    const invoke = tauriInvoke();
    if (invoke && base) void invoke('open_external', { url: `${base}/pricing` }).catch((e) => notify(String(e), 'error'));
  };
  const loadHistory = () => acc.api<{ items: Tx[] }>('GET', '/api/v1/me/transactions?limit=30').then((r) => setHistory(r.items)).catch((e) => notify(String(e.message ?? e), 'error'));

  if (!acc.user) {
    return (
      <>
        <div className="flex items-center gap-1.5 px-2 h-8 rounded-md text-muted" title="Số dư credit (cần đăng nhập)">
          <IconCoin /> <span className="tabular-nums text-xs">—</span>
        </div>
        <button
          className="h-8 flex items-center gap-1.5 px-2.5 rounded-md border border-line hover:bg-surface-2 disabled:opacity-50"
          disabled={acc.busy}
          onClick={() => (acc.configured ? void login() : notify(acc.reason ?? 'Chưa cấu hình tài khoản'))}
          title={acc.configured ? 'Đăng nhập bằng Google (mở trình duyệt)' : acc.reason ?? ''}
        >
          <IconUser /> <span className="text-xs">{acc.busy ? 'Đang chờ trình duyệt…' : 'Đăng nhập'}</span>
        </button>
      </>
    );
  }
  return (
    <div className="relative">
      <button className="h-8 flex items-center gap-2 pl-1 pr-2.5 rounded-full border border-line hover:bg-surface-2" onClick={() => setOpen(!open)} aria-haspopup="menu">
        {acc.user.avatar_url ? <img src={acc.user.avatar_url} alt="" className="h-6 w-6 rounded-full" referrerPolicy="no-referrer" /> : <IconUser />}
        <span className="text-xs max-w-28 truncate">{acc.user.name ?? acc.user.email}</span>
        <span className="flex items-center gap-1 text-xs tabular-nums font-semibold text-accent"><IconCoin size={14} />{acc.balance ?? '—'}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-10 z-40 w-72 rounded-xl border border-line bg-surface shadow-xl p-3 space-y-2 hm-enter" role="menu" onMouseLeave={() => setOpen(false)}>
          <div className="text-[12px]">
            <div className="font-semibold truncate">{acc.user.name}</div>
            <div className="text-muted truncate">{acc.user.email}</div>
          </div>
          <div className="rounded-lg bg-accent-soft p-2.5 flex items-center">
            <div>
              <div className="text-[11px] text-muted">Số dư</div>
              <div className="text-lg font-semibold tabular-nums">{acc.balance ?? '—'} credit</div>
            </div>
            <button className="ml-auto h-8 px-3 rounded-md bg-accent text-accent-fg text-[12px] font-semibold" onClick={buy}>Mua credit</button>
          </div>
          <button className="w-full text-left text-[12px] px-2 py-1.5 rounded hover:bg-surface-2" onClick={() => void loadHistory()}>Lịch sử giao dịch</button>
          {history && (
            <ul className="max-h-56 overflow-auto text-[11.5px] divide-y divide-line">
              {history.length === 0 && <li className="py-2 text-muted">Chưa có giao dịch</li>}
              {history.map((t) => (
                <li key={t.id} className="py-1.5 flex gap-2">
                  <span className="flex-1 truncate">{TYPE[t.type] ?? t.type}{t.note ? ` · ${t.note}` : ''}<br /><span className="text-muted">{t.created_at}</span></span>
                  <span className={`tabular-nums font-semibold ${t.amount > 0 ? 'text-play' : 'text-warn'}`}>{t.amount > 0 ? '+' : ''}{t.amount}</span>
                </li>
              ))}
            </ul>
          )}
          <button className="w-full text-left text-[12px] px-2 py-1.5 rounded hover:bg-surface-2" onClick={() => void acc.logout().then(() => setOpen(false))}>Đăng xuất</button>
        </div>
      )}
    </div>
  );
}
