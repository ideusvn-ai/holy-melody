<?php
declare(strict_types=1);

use HolyMelody\{Config, Db};

function e(?string $s): string
{
    return htmlspecialchars((string) $s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function vnd(int $v): string
{
    return number_format($v, 0, ',', '.') . ' VNĐ';
}

function render_page(string $path, Config $config, ?Db $db): void
{
    $base = rtrim($config->get('HM_PUBLIC_URL') ?? '', '/');
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: strict-origin-when-cross-origin');
    header("Content-Security-Policy: default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client; frame-src https://accounts.google.com/gsi/; connect-src 'self' https://accounts.google.com/gsi/; style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; img-src 'self' data: https://*.googleusercontent.com https://qr.sepay.vn");

    switch ($path) {
        case '/robots.txt':
            header('Content-Type: text/plain; charset=utf-8');
            echo "User-agent: *\nDisallow: /admin\nDisallow: /account\nSitemap: $base/sitemap.xml\n";
            return;
        case '/sitemap.xml':
            header('Content-Type: application/xml; charset=utf-8');
            echo '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';
            foreach (['/', '/download', '/pricing', '/faq'] as $p) {
                echo '<url><loc>' . e($base . $p) . '</loc></url>';
            }
            echo '</urlset>';
            return;
    }

    $pages = [
        '/' => ['Holy Melody – Đọc bản nhạc. Soạn nhạc. Biến giai điệu thành tiếng hát.', 'page_home'],
        '/download' => ['Tải Holy Melody cho macOS và Windows', 'page_download'],
        '/pricing' => ['Bảng giá credit – Holy Melody', 'page_pricing'],
        '/faq' => ['Câu hỏi thường gặp – Holy Melody', 'page_faq'],
        '/account' => ['Tài khoản – Holy Melody', 'page_account'],
        '/account/payment-return' => ['Kết quả thanh toán – Holy Melody', 'page_payment_return'],
        '/account/payment-cancel' => ['Đã hủy thanh toán – Holy Melody', 'page_payment_return'],
        '/admin' => ['Quản trị – Holy Melody', 'page_admin'],
    ];
    // trang thanh toán SePay: /pay/HM0000421234
    if (preg_match('#^/pay/([A-Za-z0-9]{4,40})$#', $path, $pm)) {
        $pages[$path] = ['Thanh toán chuyển khoản – Holy Melody', 'page_pay'];
        $ctxCode = strtoupper($pm[1]);
    }
    if (!isset($pages[$path])) {
        http_response_code(404);
        $pages[$path] = ['Không tìm thấy trang – Holy Melody', 'page_404'];
    }
    [$title, $fn] = $pages[$path];
    $ctx = ['config' => $config, 'db' => $db, 'base' => $base, 'path' => $path, 'pay_code' => $ctxCode ?? null];
    ob_start();
    $fn($ctx);
    $body = (string) ob_get_clean();
    layout($title, $body, $ctx);
}

function layout(string $title, string $body, array $ctx): void
{
    $desc = 'Holy Melody: nhận dạng bản nhạc từ ảnh/PDF, phát MIDI có highlight nốt, soạn nhạc chuyên nghiệp cho thánh ca và hợp xướng tiếng Việt, AI hát theo đúng giai điệu.';
    $nav = ['/' => 'Trang chủ', '/download' => 'Tải về', '/pricing' => 'Bảng giá', '/faq' => 'Hỏi đáp', '/account' => 'Tài khoản'];
    $gid = $ctx['config']->list('HM_GOOGLE_CLIENT_IDS')[0] ?? '';
    ?><!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title><?= e($title) ?></title>
<meta name="description" content="<?= e($desc) ?>">
<meta property="og:title" content="<?= e($title) ?>">
<meta property="og:description" content="<?= e($desc) ?>">
<meta property="og:type" content="website">
<meta property="og:url" content="<?= e($ctx['base'] . $ctx['path']) ?>">
<meta property="og:image" content="<?= e($ctx['base']) ?>/assets/og.png">
<meta name="google-client-id" content="<?= e($gid) ?>">
<link rel="icon" href="/assets/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/site.css">
<script>try{var t=localStorage.getItem('hm-theme');if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
</head>
<body>
<header class="top">
  <a class="brand" href="/"><img src="/assets/icon.svg" alt="" width="30" height="30"> Holy Melody</a>
  <nav>
    <?php foreach ($nav as $href => $label): ?>
      <a href="<?= $href ?>"<?= $ctx['path'] === $href ? ' aria-current="page"' : '' ?>><?= e($label) ?></a>
    <?php endforeach; ?>
  </nav>
  <button class="theme" id="theme" aria-label="Đổi giao diện sáng/tối">◐</button>
</header>
<main><?= $body ?></main>
<footer class="foot">
  <div>© <?= date('Y') ?> Holy Melody · Soạn và phát nhạc không cần đăng nhập · AI cần tài khoản Google</div>
  <div>Âm thanh: GeneralUser GS © S. Christian Collins · Nhận dạng bản nhạc: Audiveris (AGPL, cài riêng)</div>
</footer>
<script src="/assets/site.js" defer></script>
</body>
</html>
<?php
}

// ---------------------------------------------------------------- dữ liệu

/** @return list<array<string,mixed>> */
function releases(?Db $db): array
{
    if (!$db) {
        return [];
    }
    try {
        return $db->all(
            'SELECT r.* FROM app_releases r JOIN (SELECT platform, architecture, MAX(published_at) p FROM app_releases WHERE published_at IS NOT NULL GROUP BY platform, architecture) l
             ON l.platform = r.platform AND l.architecture = r.architecture AND l.p = r.published_at ORDER BY r.platform, r.architecture',
        );
    } catch (\Throwable) {
        return [];
    }
}

/** @return list<array<string,mixed>> */
function packages(?Db $db): array
{
    if (!$db) {
        return [];
    }
    try {
        return $db->all('SELECT id, name, credits, price_vnd FROM credit_packages WHERE active = 1 ORDER BY sort_order, id');
    } catch (\Throwable) {
        return [];
    }
}

// ---------------------------------------------------------------- trang

function page_home(array $ctx): void
{
    $rels = releases($ctx['db']);
    ?>
<section class="hero">
  <div class="hero-text reveal">
    <h1>Holy Melody</h1>
    <p class="tagline">Đọc bản nhạc. Soạn nhạc. Biến giai điệu thành tiếng hát.</p>
    <p class="lead">Phần mềm dành cho ca đoàn, nhạc sĩ thánh ca và người yêu âm nhạc: mở bản nhạc từ ảnh, PDF, MusicXML hay MIDI, nghe với nốt sáng theo từng phách, soạn và dàn trang đẹp cho khổ A4/A5, gợi ý hợp âm và kiểm tra lời ca tiếng Việt.</p>
    <div class="cta" data-downloads='<?= e(json_encode(array_map(fn ($r) => ['p' => $r['platform'], 'a' => $r['architecture'], 'u' => $r['download_url']], $rels))) ?>'>
      <a class="btn primary" href="/download#macos" data-os="macos">Download for macOS</a>
      <a class="btn" href="/download#windows" data-os="windows">Download for Windows</a>
    </div>
  </div>
  <div class="hero-art reveal" aria-hidden="true">
    <svg viewBox="0 0 520 260" class="staff-anim">
      <?php for ($i = 0; $i < 5; $i++): ?><line x1="10" x2="510" y1="<?= 70 + $i * 18 ?>" y2="<?= 70 + $i * 18 ?>" /><?php endfor; ?>
      <?php foreach ([[60, 133], [120, 124], [180, 115], [240, 124], [300, 106], [360, 115], [420, 124], [480, 133]] as $k => [$x, $y]): ?>
        <g class="n" style="--d:<?= $k * 0.35 ?>s"><ellipse cx="<?= $x ?>" cy="<?= $y ?>" rx="10" ry="7" transform="rotate(-20 <?= $x ?> <?= $y ?>)" /><line x1="<?= $x + 9 ?>" x2="<?= $x + 9 ?>" y1="<?= $y ?>" y2="<?= $y - 50 ?>" /></g>
      <?php endforeach; ?>
      <g class="wave"><?php for ($i = 0; $i < 48; $i++): ?><rect x="<?= 14 + $i * 10.4 ?>" y="200" width="5" height="40" rx="2" style="--i:<?= $i ?>" /><?php endfor; ?></g>
    </svg>
  </div>
</section>

<section class="features" id="features">
  <article class="reveal"><h2>Sheet Player</h2><p>Mở bản nhạc từ ảnh chụp, PDF, MusicXML, MIDI. Phát bằng SoundFont chất lượng cao, nốt đang phát sáng lên theo đúng thời gian, chọn đoạn để phát lặp, máy nhịp, đổi tốc độ không đổi cao độ.</p></article>
  <article class="reveal"><h2>Score Editor</h2><p>Soạn nốt bằng chuột, bàn phím, MIDI; liên ba, hợp âm, luyến láy, lời ca nhiều phiên khúc. Trợ lý soạn nhạc gợi ý quy tắc hòa âm và dấu thanh tiếng Việt. Xuất PDF in ấn, MusicXML, MIDI, WAV.</p></article>
  <article class="reveal"><h2>AI Singer</h2><p>Biến bản nhạc có lời thành bài hát với giọng AI và nhạc đệm. Chế độ Strict Melody giữ đúng cao độ, trường độ và thứ tự lời. <em>Đang hoàn thiện cùng nhà cung cấp giọng hát tiếng Việt.</em></p></article>
</section>

<section class="how reveal">
  <h2>Cách hoạt động</h2>
  <ol class="steps"><li>Tải bản nhạc lên</li><li>Nhận dạng</li><li>Phát / Chỉnh sửa</li><li>Tạo bài hát AI</li></ol>
</section>

<section class="showcase reveal">
  <h2>Giao diện thật của ứng dụng</h2>
  <div class="shots">
    <figure><img src="/assets/shot-player.png" alt="Tab Player đang phát bài thánh ca 4 bè, các nốt đang phát được tô sáng" loading="lazy"><figcaption>Player: highlight theo audio clock</figcaption></figure>
    <figure><img src="/assets/shot-editor.png" alt="Score Editor với gợi ý hợp âm thông minh" loading="lazy"><figcaption>Score Editor: hợp âm thông minh</figcaption></figure>
    <figure><img src="/assets/shot-lyrics.png" alt="Soạn lời ca nhiều phiên khúc" loading="lazy"><figcaption>Lời ca thông minh</figcaption></figure>
  </div>
</section>

<?php page_pricing($ctx, true); ?>
<?php page_faq($ctx, true); ?>
<?php
}

function page_download(array $ctx): void
{
    $rels = releases($ctx['db']);
    $label = ['macos-arm64' => 'macOS – Apple Silicon (M1/M2/M3/M4)', 'macos-x64' => 'macOS – Intel', 'windows-x64' => 'Windows 10/11 – x64', 'windows-arm64' => 'Windows – ARM64'];
    ?>
<section class="page">
  <h1>Tải Holy Melody</h1>
  <p class="lead" id="os-hint">Chọn bản phù hợp với máy của bạn.</p>
  <?php if (!$rels): ?>
    <div class="note">Chưa có bản phát hành chính thức. Bản build thử nghiệm có tại mục Releases của dự án trên GitHub.</div>
  <?php else: ?>
  <div class="downloads">
    <?php foreach ($rels as $r): $k = $r['platform'] . '-' . $r['architecture']; ?>
      <article class="dl" id="<?= e($r['platform']) ?>" data-key="<?= e($k) ?>">
        <h2><?= e($label[$k] ?? $k) ?></h2>
        <p>Phiên bản <b><?= e($r['version']) ?></b> · <?= e(substr((string) $r['published_at'], 0, 10)) ?> · <?= number_format(((int) $r['file_size']) / 1048576, 1) ?> MB</p>
        <a class="btn primary" href="<?= e($r['download_url']) ?>">Tải về</a>
        <details><summary>SHA-256</summary><code class="sha"><?= e($r['checksum']) ?></code></details>
        <?php if (!(int) $r['signed']): ?><p class="small">Bản này chưa được ký số: lần đầu mở trên macOS chuột phải → Open; trên Windows chọn More info → Run anyway.</p><?php endif; ?>
        <?php if ($r['release_notes']): ?><details><summary>Ghi chú phát hành</summary><div class="notes"><?= nl2br(e($r['release_notes'])) ?></div></details><?php endif; ?>
      </article>
    <?php endforeach; ?>
  </div>
  <?php endif; ?>
  <h2>Yêu cầu hệ thống</h2>
  <ul>
    <li>macOS 11 Big Sur trở lên (Apple Silicon hoặc Intel)</li>
    <li>Windows 10 (1809+) hoặc Windows 11, 64-bit; WebView2 được cài tự động nếu thiếu</li>
    <li>4 GB RAM, 500 MB dung lượng trống</li>
    <li>Nhận dạng ảnh/PDF: cài thêm Audiveris (miễn phí)</li>
  </ul>
</section>
<?php
}

function page_pricing(array $ctx, bool $embedded = false): void
{
    $pk = packages($ctx['db']);
    ?>
<section class="<?= $embedded ? 'pricing reveal' : 'page pricing' ?>" id="pricing">
  <h<?= $embedded ? 2 : 1 ?>>Bảng giá credit</h<?= $embedded ? 2 : 1 ?>>
  <p class="lead">Soạn và phát nhạc miễn phí, không cần tài khoản. Credit chỉ dùng cho các tính năng AI. Tài khoản mới được tặng <b>100 credit</b>. 1 credit = 1.000 VNĐ.</p>
  <?php if (!$pk): ?>
    <div class="note">Bảng giá đang được cập nhật.</div>
  <?php else: ?>
  <div class="plans">
    <?php foreach ($pk as $p): ?>
      <article class="plan">
        <h3><?= e($p['name']) ?></h3>
        <div class="credits"><?= number_format((int) $p['credits'], 0, ',', '.') ?> <small>credit</small></div>
        <div class="price"><?= vnd((int) $p['price_vnd']) ?></div>
        <button class="btn primary buy" data-package="<?= (int) $p['id'] ?>">Mua</button>
      </article>
    <?php endforeach; ?>
  </div>
  <p class="small">Thanh toán bằng chuyển khoản ngân hàng qua mã VietQR (xác nhận tự động bởi SePay): quét mã bằng app ngân hàng bất kỳ, credit được cộng ngay khi tiền vào tài khoản. Mỗi tác vụ AI mặc định 10 credit; job lỗi do hệ thống được hoàn credit tự động.</p>
  <?php endif; ?>
</section>
<?php
}

function page_faq(array $ctx, bool $embedded = false): void
{
    $qa = [
        'Có cần Internet không?' => 'Không cho các chức năng cơ bản: mở, soạn, chỉnh sửa, phát nhạc và xuất MusicXML/MIDI/PDF/WAV đều chạy offline. Chỉ AI và đồng bộ tài khoản cần Internet.',
        'Có cần đăng nhập không?' => 'Không. Chỉ khi dùng tính năng AI mới cần đăng nhập bằng tài khoản Google.',
        'Có hỗ trợ tiếng Việt không?' => 'Có. Giao diện tiếng Việt, lời ca Unicode có dấu, tách âm tiết, nhiều phiên khúc, và Trợ lý soạn nhạc kiểm tra dấu thanh với hướng đi giai điệu để lời không bị nghe sai.',
        'Có đọc PDF scan không?' => 'Có, qua Audiveris (miễn phí, cài riêng). Kết quả nhận dạng không thể đúng 100%, nên các nốt được đánh dấu "chưa xác minh" để bạn đối chiếu và sửa trước khi dùng.',
        'Có thể xuất MIDI không?' => 'Có: MIDI giữ đúng cao độ, trường độ, tempo, số chỉ nhịp, hóa biểu, nhiều track, nhạc cụ và cường độ. Ngoài ra còn MusicXML, MXL, PDF, PNG, SVG và WAV.',
        'AI có giữ đúng giai điệu không?' => 'Chế độ Strict Melody chỉ dùng công nghệ tổng hợp giọng hát theo từng nốt và lời, không phải dịch vụ "tạo nhạc từ mô tả". Tính năng chỉ được bật khi nhà cung cấp đáp ứng yêu cầu này; trước đó bạn không thể tạo và không bị trừ credit.',
        'Credit được tính thế nào?' => 'Mỗi tác vụ AI hợp lệ mặc định 10 credit, hiển thị trước khi xác nhận. Hệ thống tự thử lại không tính thêm phí; job lỗi do hệ thống được hoàn credit. 100 credit = 100.000 VNĐ.',
    ];
    ?>
<section class="<?= $embedded ? 'faq reveal' : 'page faq' ?>" id="faq">
  <h<?= $embedded ? 2 : 1 ?>>Câu hỏi thường gặp</h<?= $embedded ? 2 : 1 ?>>
  <?php foreach ($qa as $q => $a): ?><details><summary><?= e($q) ?></summary><p><?= e($a) ?></p></details><?php endforeach; ?>
</section>
<?php
}

function page_account(array $ctx): void
{
    ?>
<section class="page account" id="account-app">
  <h1>Tài khoản</h1>
  <div id="signed-out">
    <p class="lead">Đăng nhập bằng Google để xem credit, nạp credit và tải lại kết quả AI.</p>
    <div id="g-signin"></div>
    <p class="small" id="g-missing" hidden>Đăng nhập chưa được cấu hình trên máy chủ.</p>
  </div>
  <div id="signed-in" hidden>
    <div class="acct-head"><img id="acct-avatar" alt="" width="48" height="48"><div><b id="acct-name"></b><div id="acct-email" class="small"></div></div>
      <div class="balance"><span id="acct-balance">0</span> credit</div><button class="btn" id="logout">Đăng xuất</button></div>
    <h2>Nạp credit</h2><div id="acct-plans" class="plans"></div>
    <h2>Lịch sử giao dịch</h2><table class="tbl" id="acct-tx"><thead><tr><th>Thời gian</th><th>Loại</th><th>Số credit</th><th>Số dư</th></tr></thead><tbody></tbody></table>
    <h2>Tác vụ AI</h2><table class="tbl" id="acct-jobs"><thead><tr><th>#</th><th>Loại</th><th>Trạng thái</th><th>Credit</th><th>Kết quả</th></tr></thead><tbody></tbody></table>
  </div>
</section>
<?php
}

function page_payment_return(array $ctx): void
{
    ?>
<section class="page">
  <h1><?= $ctx['path'] === '/account/payment-cancel' ? 'Bạn đã hủy thanh toán' : 'Đang xác nhận thanh toán…' ?></h1>
  <p class="lead" id="pay-status">Credit chỉ được cộng khi cổng thanh toán xác nhận trực tiếp với máy chủ. Trang này tự cập nhật.</p>
  <p><a class="btn" href="/account">Về trang tài khoản</a></p>
</section>
<?php
}

function page_pay(array $ctx): void
{
    $code = e((string) $ctx['pay_code']);
    ?>
<section class="page pay" id="pay-app" data-code="<?= $code ?>">
  <h1>Thanh toán chuyển khoản</h1>
  <div id="pay-loading" class="lead">Đang tải thông tin thanh toán…</div>
  <div id="pay-missing" class="note" hidden>Không tìm thấy đơn thanh toán này.</div>
  <div id="pay-body" class="pay-grid" hidden>
    <figure class="pay-qr">
      <img id="pay-qr" alt="Mã VietQR chuyển khoản" width="300" height="300">
      <figcaption>Mở app ngân hàng → <b>Quét mã QR</b>. Số tiền và nội dung đã điền sẵn.</figcaption>
    </figure>
    <div class="pay-info">
      <dl>
        <dt>Ngân hàng</dt><dd id="pay-bank"></dd>
        <dt>Số tài khoản</dt><dd><span id="pay-acc"></span> <button class="copy" data-copy="pay-acc">Chép</button></dd>
        <dt>Chủ tài khoản</dt><dd id="pay-holder"></dd>
        <dt>Số tiền</dt><dd><b id="pay-amount"></b> <button class="copy" data-copy="pay-amount-raw">Chép</button><span id="pay-amount-raw" hidden></span></dd>
        <dt>Nội dung</dt><dd><b id="pay-code" class="mono"></b> <button class="copy" data-copy="pay-code">Chép</button></dd>
        <dt>Nhận được</dt><dd><b id="pay-credits"></b> credit</dd>
      </dl>
      <p class="note warn">Chuyển khoản thủ công: nhập <b>đúng nội dung</b> và <b>đúng số tiền</b> như trên để hệ thống tự xác nhận.</p>
      <p id="pay-state" class="pay-state" aria-live="polite">⏳ Đang chờ chuyển khoản… <span id="pay-timer"></span></p>
    </div>
  </div>
  <div id="pay-done" class="pay-done" hidden>
    <h2>✅ Thanh toán thành công</h2>
    <p class="lead">Đã cộng <b id="pay-done-credits"></b> credit vào tài khoản. Bạn có thể quay lại ứng dụng Holy Melody.</p>
    <p><a class="btn" href="/account">Xem tài khoản</a></p>
  </div>
</section>
<?php
}

function page_admin(array $ctx): void
{
    ?>
<section class="page admin" id="admin-app">
  <h1>Quản trị</h1>
  <p class="small">Cần đăng nhập bằng tài khoản có quyền quản trị (đăng nhập tại <a href="/account">Tài khoản</a>).</p>
  <div id="admin-denied" class="note" hidden>Bạn chưa đăng nhập hoặc không có quyền quản trị.</div>
  <div id="admin-body" hidden>
    <div class="kpis" id="kpis"></div>
    <div class="charts">
      <figure><figcaption>Doanh thu 30 ngày (VNĐ)</figcaption><svg id="ch-revenue" viewBox="0 0 600 160"></svg></figure>
      <figure><figcaption>Người dùng hoạt động</figcaption><svg id="ch-active" viewBox="0 0 600 160"></svg></figure>
      <figure><figcaption>Credit đã dùng</figcaption><svg id="ch-credits" viewBox="0 0 600 160"></svg></figure>
      <figure><figcaption>AI jobs</figcaption><svg id="ch-jobs" viewBox="0 0 600 160"></svg></figure>
    </div>
    <h2>Điều chỉnh credit thủ công</h2>
    <form id="adj" class="row"><input name="user" placeholder="ID người dùng" required inputmode="numeric"><input name="amount" placeholder="Số credit (+/-)" required inputmode="numeric"><input name="reason" placeholder="Lý do (bắt buộc)" required minlength="5"><button class="btn primary">Thực hiện</button></form>
    <h2>Người dùng</h2><form id="user-search" class="row"><input name="q" placeholder="Tìm email / tên"><button class="btn">Tìm</button></form><table class="tbl" id="tb-users"></table>
    <h2>Gói credit & giá AI</h2><table class="tbl" id="tb-packages"></table><table class="tbl" id="tb-pricing"></table>
    <h2>Đơn hàng</h2><table class="tbl" id="tb-orders"></table>
    <h2>Thanh toán lỗi / nghi vấn</h2><table class="tbl" id="tb-events"></table>
    <h2>AI jobs</h2><table class="tbl" id="tb-jobs"></table>
    <h2>Đăng bản phát hành</h2>
    <form id="release" class="grid"><input name="version" placeholder="0.1.0" required><select name="platform"><option>macos</option><option>windows</option></select><select name="architecture"><option>arm64</option><option>x64</option></select><input name="download_url" placeholder="https://…" required><input name="file_size" placeholder="Kích thước (byte)" inputmode="numeric"><input name="checksum" placeholder="SHA-256" required><label><input type="checkbox" name="signed"> Đã ký số</label><textarea name="release_notes" placeholder="Ghi chú phát hành"></textarea><button class="btn primary">Đăng</button></form>
    <h2>Lỗi hệ thống</h2><table class="tbl" id="tb-errors"></table>
  </div>
</section>
<?php
}

function page_404(array $ctx): void
{
    echo '<section class="page"><h1>Không tìm thấy trang</h1><p><a class="btn" href="/">Về trang chủ</a></p></section>';
}
