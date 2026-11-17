// Holy Melody website – không phụ thuộc thư viện
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (n) => Number(n).toLocaleString('vi-VN');

  // ---- giao diện sáng/tối
  $('#theme')?.addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('hm-theme', next); } catch {}
  });

  // ---- hiệu ứng xuất hiện khi cuộn
  const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && (e.target.classList.add('in'), io.unobserve(e.target))), { threshold: 0.12 });
  $$('.reveal').forEach((el) => io.observe(el));

  // ---- nhận diện hệ điều hành để gợi ý bản tải
  const ua = navigator.userAgent;
  const os = /Mac/i.test(ua) ? 'macos' : /Win/i.test(ua) ? 'windows' : null;
  const cta = $('.cta[data-downloads]');
  if (cta && os) {
    const list = JSON.parse(cta.dataset.downloads || '[]');
    const mine = list.filter((r) => r.p === os);
    // Apple Silicon không lộ trong UA; mặc định arm64 cho Mac mới, Intel vẫn chọn được ở trang Tải về
    const pick = mine.find((r) => r.a === 'arm64') || mine[0];
    const btn = $(`[data-os="${os}"]`, cta);
    if (btn) {
      btn.classList.add('primary');
      $$('[data-os]', cta).filter((b) => b !== btn).forEach((b) => b.classList.remove('primary'));
      if (pick) btn.href = pick.u;
      cta.prepend(btn);
    }
  }
  if (os && $('#os-hint')) {
    $('#os-hint').textContent = os === 'macos' ? 'Bạn đang dùng macOS — chọn Apple Silicon (M1 trở lên) hoặc Intel.' : 'Bạn đang dùng Windows — tải bản Windows x64.';
    $$(`.dl[data-key^="${os}"]`).forEach((d) => d.classList.add('recommended'));
  }

  // ---- API
  const csrf = () => { try { return sessionStorage.getItem('hm-csrf') || ''; } catch { return ''; } };
  async function api(method, path, body, idem) {
    const h = { Accept: 'application/json' };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (method !== 'GET') h['X-CSRF-Token'] = csrf();
    if (idem) h['Idempotency-Key'] = idem;
    const r = await fetch(path, { method, headers: h, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
    const data = r.status === 204 ? null : await r.json().catch(() => null);
    if (!r.ok) throw Object.assign(new Error(data?.error?.message || `Lỗi ${r.status}`), { code: data?.error?.code, status: r.status });
    return data;
  }

  // ---- đăng nhập Google (Google Identity Services, có One Tap)
  const gid = $('meta[name="google-client-id"]')?.content;
  function loadGis(cb) {
    if (!gid) return;
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = cb;
    document.head.appendChild(s);
  }
  async function onCredential(resp) {
    try {
      const r = await api('POST', '/api/v1/auth/google', { id_token: resp.credential, client: 'web' });
      try { sessionStorage.setItem('hm-csrf', r.csrf_token || ''); } catch {}
      location.reload();
    } catch (e) { alert(e.message); }
  }

  // ---- mua credit (cần đăng nhập)
  async function buy(pkgId) {
    try {
      const order = await api('POST', '/api/v1/payments/orders', { package_id: Number(pkgId), gateway: 'payos' }, crypto.randomUUID());
      try { sessionStorage.setItem('hm-last-order', String(order.id)); } catch {}
      if (order.checkout_url) location.href = order.checkout_url;
    } catch (e) {
      if (e.status === 401) location.href = '/account';
      else alert(e.message);
    }
  }
  $$('.buy').forEach((b) => b.addEventListener('click', () => buy(b.dataset.package)));

  // ---- trang tài khoản
  const TYPE = { signup_bonus: 'Quà tài khoản mới', purchase: 'Nạp credit', ai_charge: 'Dùng AI', ai_refund: 'Hoàn credit AI', admin_adjustment: 'Điều chỉnh', reversal: 'Đảo giao dịch' };
  const JOB = { pending: 'Đang chờ', processing: 'Đang xử lý', completed: 'Hoàn thành', failed: 'Thất bại', cancelled: 'Đã hủy' };
  async function account() {
    if (!$('#account-app')) return;
    try {
      const me = await api('GET', '/api/v1/me');
      $('#signed-out').hidden = true;
      $('#signed-in').hidden = false;
      $('#acct-name').textContent = me.user.name || '';
      $('#acct-email').textContent = me.user.email || '';
      if (me.user.avatar_url) $('#acct-avatar').src = me.user.avatar_url; else $('#acct-avatar').remove();
      $('#acct-balance').textContent = fmt(me.balance);
      const [tx, jobs, pricing] = await Promise.all([api('GET', '/api/v1/me/transactions'), api('GET', '/api/v1/ai/jobs'), api('GET', '/api/v1/pricing')]);
      $('#acct-tx tbody').innerHTML = tx.items.map((t) => `<tr><td>${esc(t.created_at)}</td><td>${esc(TYPE[t.type] || t.type)}${t.note ? ' · ' + esc(t.note) : ''}</td><td style="color:var(--${t.amount > 0 ? 'ok' : 'warn'})">${t.amount > 0 ? '+' : ''}${fmt(t.amount)}</td><td>${fmt(t.balance_after)}</td></tr>`).join('') || '<tr><td colspan="4">Chưa có giao dịch</td></tr>';
      const rows = await Promise.all(jobs.items.map(async (j) => {
        let out = '';
        if (j.status === 'completed') {
          const d = await api('GET', `/api/v1/ai/jobs/${j.id}`).catch(() => null);
          out = (d?.outputs || []).map((o) => `<a href="/api/v1/ai/outputs/${o.id}">${esc(o.kind)}.${esc(o.format)}</a>`).join(' · ');
        }
        return `<tr><td>${j.id}</td><td>${esc(j.job_type)}</td><td>${esc(JOB[j.status] || j.status)}</td><td>${j.credit_cost}</td><td>${out}</td></tr>`;
      }));
      $('#acct-jobs tbody').innerHTML = rows.join('') || '<tr><td colspan="5">Chưa có tác vụ</td></tr>';
      $('#acct-plans').innerHTML = pricing.packages.map((p) => `<article class="plan"><h3>${esc(p.name)}</h3><div class="credits">${fmt(p.credits)} <small>credit</small></div><div class="price">${fmt(p.price_vnd)} VNĐ</div><button class="btn primary buy" data-package="${p.id}">Mua</button></article>`).join('');
      $$('#acct-plans .buy').forEach((b) => b.addEventListener('click', () => buy(b.dataset.package)));
      $('#logout').addEventListener('click', async () => { await api('POST', '/api/v1/auth/logout').catch(() => {}); location.reload(); });
    } catch (e) {
      if (e.status !== 401) console.error(e);
      if (!gid) { $('#g-missing').hidden = false; return; }
      loadGis(() => {
        google.accounts.id.initialize({ client_id: gid, callback: onCredential, use_fedcm_for_prompt: true });
        google.accounts.id.renderButton($('#g-signin'), { theme: 'outline', size: 'large', text: 'signin_with', locale: 'vi' });
        google.accounts.id.prompt(); // One Tap
      });
    }
  }
  account();

  // ---- kết quả thanh toán: hỏi trạng thái đơn từ máy chủ (không tin callback phía trình duyệt)
  if ($('#pay-status') && location.pathname.endsWith('payment-return')) {
    let id; try { id = sessionStorage.getItem('hm-last-order'); } catch {}
    let n = 0;
    const tick = async () => {
      if (!id) return;
      const o = await api('GET', `/api/v1/payments/orders/${id}`).catch(() => null);
      if (o?.status === 'paid') { $('#pay-status').textContent = `Đã cộng ${fmt(o.credits)} credit vào tài khoản. Cảm ơn bạn!`; return; }
      if (o && o.status !== 'pending') { $('#pay-status').textContent = `Trạng thái đơn hàng: ${o.status}.`; return; }
      if (++n < 40) setTimeout(tick, 3000); else $('#pay-status').textContent = 'Chưa nhận được xác nhận từ cổng thanh toán. Credit sẽ được cộng tự động khi có xác nhận.';
    };
    tick();
  }

  // ---- trang quản trị
  function bars(svg, rows, key = 'n') {
    if (!svg) return;
    const W = 600, H = 160, pad = 22;
    const max = Math.max(1, ...rows.map((r) => Number(r[key])));
    const bw = (W - pad * 2) / Math.max(1, rows.length);
    svg.innerHTML = rows.map((r, i) => {
      const h = (Number(r[key]) / max) * (H - pad * 2);
      return `<rect x="${pad + i * bw + 1}" y="${H - pad - h}" width="${Math.max(1, bw - 2)}" height="${h}" rx="2"><title>${esc(r.d)}: ${fmt(r[key])}</title></rect>`;
    }).join('') + `<text x="${pad}" y="12">max ${fmt(max)}</text>` + (rows.length ? `<text x="${pad}" y="${H - 6}">${esc(rows[0].d)}</text><text x="${W - pad}" y="${H - 6}" text-anchor="end">${esc(rows.at(-1).d)}</text>` : `<text x="${W / 2}" y="${H / 2}" text-anchor="middle">Chưa có dữ liệu</text>`);
  }
  const table = (el, rows, cols) => { if (el) el.innerHTML = `<thead><tr>${cols.map((c) => `<th>${esc(c[1])}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td>${esc(typeof c[2] === 'function' ? c[2](r) : r[c[0]])}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${cols.length}">Không có dữ liệu</td></tr>`}</tbody>`; };
  async function admin() {
    if (!$('#admin-app')) return;
    try {
      const [s, m] = await Promise.all([api('GET', '/api/v1/admin/stats'), api('GET', '/api/v1/admin/metrics')]);
      $('#admin-body').hidden = false;
      const conv = m.conversion?.total ? ((m.conversion.paying / m.conversion.total) * 100).toFixed(1) + '%' : '—';
      $('#kpis').innerHTML = [['Người dùng', s.users], ['Mới 7 ngày', s.new_users_7d], ['Credit đã cấp', s.credits_granted], ['Credit đã dùng', s.credits_used], ['Doanh thu', fmt(s.revenue_vnd) + ' đ'], ['Tỉ lệ chuyển đổi', conv]]
        .map(([k, v]) => `<div class="kpi"><span class="small">${esc(k)}</span><b>${typeof v === 'number' ? fmt(v) : esc(v)}</b></div>`).join('');
      bars($('#ch-revenue'), s.revenue_daily, 'vnd');
      bars($('#ch-active'), m.active_users_daily);
      bars($('#ch-credits'), m.credit_consumption_daily);
      bars($('#ch-jobs'), m.jobs_daily);
      table($('#tb-packages'), m.packages, [['name', 'Gói'], ['credits', 'Credit'], ['price_vnd', 'Giá (VNĐ)'], ['active', 'Bật']]);
      table($('#tb-pricing'), m.pricing, [['job_type', 'Tác vụ AI'], ['credit_cost', 'Credit / lần'], ['active', 'Bật']]);
      const [orders, events, jobs, errors] = await Promise.all(['orders', 'payment-events', 'jobs', 'errors'].map((x) => api('GET', `/api/v1/admin/${x}`)));
      table($('#tb-orders'), orders.items, [['id', '#'], ['email', 'Email'], ['amount_vnd', 'VNĐ'], ['credits', 'Credit'], ['status', 'Trạng thái'], ['gateway', 'Cổng'], ['created_at', 'Tạo lúc'], ['paid_at', 'Thanh toán']]);
      table($('#tb-events'), events.items, [['id', '#'], ['payment_order_id', 'Đơn'], ['gateway', 'Cổng'], ['verification_status', 'Kết quả xác minh'], ['received_at', 'Lúc']]);
      table($('#tb-jobs'), jobs.items, [['id', '#'], ['email', 'Email'], ['job_type', 'Loại'], ['status', 'Trạng thái'], ['credit_cost', 'Credit'], ['provider', 'Provider'], ['attempts', 'Lần thử'], ['cost_usd_micros', 'Chi phí (USD)', (r) => (r.cost_usd_micros / 1e6).toFixed(4)]]);
      table($('#tb-errors'), errors.items, [['created_at', 'Lúc'], ['source', 'Nguồn'], ['level', 'Mức'], ['message', 'Nội dung']]);
      const loadUsers = async (q = '') => table($('#tb-users'), (await api('GET', `/api/v1/admin/users?q=${encodeURIComponent(q)}`)).items, [['id', 'ID'], ['email', 'Email'], ['name', 'Tên'], ['balance', 'Credit'], ['status', 'Trạng thái'], ['created_at', 'Tạo lúc']]);
      loadUsers();
      $('#user-search').addEventListener('submit', (e) => { e.preventDefault(); loadUsers(new FormData(e.target).get('q')); });
      $('#adj').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        if (!confirm(`Điều chỉnh ${f.get('amount')} credit cho người dùng #${f.get('user')}?`)) return;
        try { const r = await api('POST', `/api/v1/admin/users/${Number(f.get('user'))}/credits`, { amount: Number(f.get('amount')), reason: f.get('reason') }); alert(`Xong. Số dư mới: ${fmt(r.balance)}`); e.target.reset(); } catch (x) { alert(x.message); }
      });
      $('#release').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        try { await api('POST', '/api/v1/admin/releases', { ...f, file_size: Number(f.file_size || 0), signed: !!f.signed }); alert('Đã đăng bản phát hành'); } catch (x) { alert(x.message); }
      });
    } catch (e) {
      $('#admin-denied').hidden = false;
    }
  }
  admin();
})();
