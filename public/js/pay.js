(() => {
  const el = document.getElementById('rzp');
  const btn = document.getElementById('rzpPay');
  const msg = document.getElementById('rzpMsg');
  if (!el) return;
  const d = el.dataset, csrf = document.body.dataset.csrf;

  function open() {
    if (!window.Razorpay) { msg.textContent = 'Could not load the payment window. Check your connection and try again.'; return; }
    const rz = new Razorpay({
      key: d.key, amount: d.amount, currency: 'INR', name: d.name, description: 'Order ' + d.number, order_id: d.order,
      prefill: { name: d.cname, email: d.email, contact: d.phone },
      theme: { color: '#315352' },
      handler: async (resp) => {
        msg.textContent = 'Verifying payment...';
        btn.disabled = true;
        try {
          const r = await fetch('/pay/razorpay/verify', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ ...resp, number: d.number }) });
          const j = await r.json();
          if (j.ok) location.href = j.redirect; else { msg.textContent = j.error || 'Payment could not be verified. If money was deducted, contact us with your order number.'; btn.disabled = false; }
        } catch { msg.textContent = 'Network error while verifying. If money was deducted, your order will still be confirmed shortly.'; btn.disabled = false; }
      },
      modal: { ondismiss: () => { msg.textContent = 'Payment window closed. You can try again.'; } },
    });
    rz.on('payment.failed', (r) => { msg.textContent = (r.error && r.error.description) || 'Payment failed. Please try again.'; });
    rz.open();
  }
  btn.addEventListener('click', open);
  setTimeout(open, 400);
})();
