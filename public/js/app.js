(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const csrf = document.body.dataset.csrf;
  const inr = new Intl.NumberFormat('en-IN');

  /* toast */
  const toastEl = $('#toast');
  let tt;
  function toast(msg, opts = {}) {
    toastEl.innerHTML = '';
    toastEl.append(document.createTextNode(msg));
    if (opts.link) { const a = document.createElement('a'); a.href = opts.link[0]; a.textContent = opts.link[1]; toastEl.append(a); }
    toastEl.classList.toggle('err', !!opts.error);
    toastEl.classList.add('show');
    clearTimeout(tt); tt = setTimeout(() => toastEl.classList.remove('show'), opts.error ? 4500 : 3200);
  }
  async function post(url, data) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, Accept: 'application/json' }, body: JSON.stringify(data) });
    let j = {}; try { j = await r.json(); } catch {}
    return { status: r.status, ...j };
  }
  const setCount = (n) => { const b = $('#cartCount'); if (!b) return; b.textContent = n; b.hidden = !n; };

  /* mobile drawer */
  const drawer = $('#drawer');
  $('#menuBtn')?.addEventListener('click', () => drawer.classList.add('open'));
  drawer?.addEventListener('click', (e) => { if (e.target === drawer) drawer.classList.remove('open'); });

  /* search + suggestions */
  const sb = $('#searchbar'), si = $('#searchInput'), sug = $('#suggest'), sl = $('#suggestList');
  $('#searchBtn')?.addEventListener('click', () => { sb.classList.toggle('open'); if (sb.classList.contains('open')) si.focus(); });
  let st;
  si?.addEventListener('input', () => {
    clearTimeout(st);
    const q = si.value.trim();
    if (q.length < 2) { sug.hidden = true; return; }
    st = setTimeout(async () => {
      try {
        const res = await (await fetch('/api/search?q=' + encodeURIComponent(q))).json();
        sl.innerHTML = '';
        res.forEach((p) => {
          const a = document.createElement('a'); a.href = '/product/' + p.slug;
          const img = document.createElement('img'); img.src = p.image || ''; img.alt = ''; img.width = 44; img.height = 56;
          const d = document.createElement('div'); const b = document.createElement('b'); b.textContent = p.name;
          const s = document.createElement('div'); s.className = 'small muted'; s.textContent = p.category + ' · ₹' + inr.format(p.price);
          d.append(b, s); a.append(img, d); sl.append(a);
        });
        sug.hidden = !res.length;
      } catch {}
    }, 200);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { sb?.classList.remove('open'); drawer?.classList.remove('open'); $$('.modal.open').forEach((m) => m.classList.remove('open')); } });

  /* shop filters (mobile) + auto submit selects + print */
  $('[data-open-filters]')?.addEventListener('click', () => $('#filters').classList.add('open'));
  $('[data-close-filters]')?.addEventListener('click', () => $('#filters').classList.remove('open'));
  $$('[data-autosubmit]').forEach((el) => el.addEventListener('change', () => el.form.submit()));
  $$('[data-print]').forEach((el) => el.addEventListener('click', () => window.print()));

  /* modals */
  $$('[data-modal]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); $('#' + a.dataset.modal).classList.add('open'); }));
  $$('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m || e.target.hasAttribute('data-close')) m.classList.remove('open'); }));

  /* wishlist hearts */
  document.addEventListener('click', async (e) => {
    const h = e.target.closest('[data-wish]');
    if (!h) return;
    e.preventDefault();
    const r = await post('/wishlist/toggle', { pid: h.dataset.wish });
    if (r.login) { toast('Please sign in to save favourites.', { link: ['/login?next=' + encodeURIComponent(location.pathname), 'Sign in'] }); return; }
    if (r.ok) { $$(`[data-wish="${h.dataset.wish}"]`).forEach((b) => { b.classList.toggle('on', r.saved); b.setAttribute('aria-pressed', r.saved); }); toast(r.saved ? 'Saved to wishlist' : 'Removed from wishlist'); }
  });

  /* product page */
  const pdp = $('#pdp');
  if (pdp) {
    const variants = JSON.parse($('#variantData').textContent);
    const form = $('#buyForm'), qty = $('#qty'), note = $('#stockNote');
    const low = Number(pdp.dataset.low || 5);
    const stockOf = (c, s) => (variants.find((v) => v.color === c && v.size === s) || {}).stock || 0;
    const curColor = () => form.color.value;
    const curSize = () => (form.size.value || '');

    function refresh() {
      const c = curColor();
      $('#colorName').textContent = c;
      $$('input[name=size]', form).forEach((i) => {
        const s = stockOf(c, i.value); i.disabled = s <= 0;
        if (i.disabled && i.checked) i.checked = false;
      });
      $$('.swatches label').forEach((l) => l.classList.toggle('soldout', !variants.some((v) => v.color === l.dataset.c && v.stock > 0)));
      const sz = curSize();
      $('#sizeName').textContent = sz || 'Select a size';
      const any = variants.some((v) => v.color === c && v.stock > 0);
      note.className = 'stock-note';
      if (!any) { note.textContent = 'This colour is sold out.'; note.classList.add('out'); }
      else if (sz) {
        const s = stockOf(c, sz);
        qty.max = Math.min(10, s);
        if (Number(qty.value) > s) qty.value = s;
        if (s <= low) { note.textContent = `Only ${s} left in this size`; note.classList.add('low'); } else note.textContent = 'In stock';
      } else note.textContent = '';
    }
    form.addEventListener('change', refresh);
    refresh();

    $$('[data-q]', form).forEach((b) => b.addEventListener('click', () => {
      const max = Number(qty.max) || 10;
      qty.value = Math.max(1, Math.min(max, Number(qty.value || 1) + Number(b.dataset.q)));
    }));
    $$('.thumbs button').forEach((b) => b.addEventListener('click', () => {
      $('#mainImg').src = b.dataset.img;
      $$('.thumbs button').forEach((x) => x.classList.toggle('on', x === b));
    }));

    let buyNow = false;
    $('#buyBtn').addEventListener('click', () => { buyNow = true; });
    $('#stickyAdd')?.addEventListener('click', () => form.requestSubmit($('#addBtn')));
    form.addEventListener('submit', async (e) => {
      if (!form.size.value) { e.preventDefault(); buyNow = false; toast('Please select a size', { error: true }); $('.sizes').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
      if (buyNow) return; // regular form post -> goes straight to checkout
      e.preventDefault();
      const btn = $('#addBtn'); btn.disabled = true;
      const r = await post('/cart/add', { pid: pdp.dataset.pid, color: curColor(), size: curSize(), qty: Number(qty.value) || 1 });
      btn.disabled = false;
      if (r.count !== undefined) setCount(r.count);
      if (r.ok) toast(r.message || 'Added to your bag', { link: ['/cart', 'View bag'] }); else toast(r.error || 'Could not add to bag', { error: true });
    });
  }

  /* checkout: COD fee */
  const grand = $('#grand');
  if (grand) {
    const upd = () => {
      const m = $('[data-method]:checked');
      const cod = m && m.value === 'cod';
      $('#codRow').hidden = !cod;
      grand.textContent = '₹' + inr.format(Number(grand.dataset.base) + (cod ? Number(grand.dataset.cod) : 0));
    };
    $$('[data-method]').forEach((r) => r.addEventListener('change', upd));
    upd();
    $('#checkoutForm').addEventListener('submit', (e) => {
      const f = e.target;
      if (!f.checkValidity()) { e.preventDefault(); f.reportValidity(); return; }
      const b = $('#placeBtn'); b.disabled = true; b.textContent = 'Placing order...';
    });
  }
})();
