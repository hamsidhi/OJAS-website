// Sends email through SMTP when configured; otherwise writes the message to data/outbox.log (handy while testing).
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const { getSettings } = require('../db');
const { money, esc, ORDER_STATUS, PAY_METHOD } = require('./util');

let transport = null;
function getTransport() {
  if (transport !== null) return transport;
  transport = process.env.SMTP_HOST
    ? nodemailer.createTransport({
        host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587),
        secure: String(process.env.SMTP_SECURE) === 'true',
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      })
    : false;
  return transport;
}
const emailEnabled = () => !!process.env.SMTP_HOST;

async function send({ to, subject, html, replyTo }) {
  if (!to) return;
  const s = getSettings();
  const from = process.env.MAIL_FROM || `${s.store_name} <${process.env.SMTP_USER || s.email}>`;
  const t = getTransport();
  if (!t) {
    const line = `\n---- ${new Date().toISOString()} ----\nTo: ${to}\nSubject: ${subject}\n${html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')}\n`;
    fs.mkdirSync(path.join(__dirname, '..', '..', 'data'), { recursive: true });
    fs.appendFileSync(path.join(__dirname, '..', '..', 'data', 'outbox.log'), line);
    console.log(`[mail:dev] "${subject}" -> ${to} (SMTP not configured; see data/outbox.log)`);
    return;
  }
  try { await t.sendMail({ from, to, subject, html, replyTo }); }
  catch (e) { console.error('[mail] failed:', e.message); }
}

const wrap = (title, inner) => `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#222">
<h2 style="color:#315352;margin:0 0 12px">${esc(getSettings().store_name)}</h2><h3>${title}</h3>${inner}
<p style="color:#888;font-size:12px;margin-top:24px">${esc(getSettings().store_name)} - ${esc(getSettings().tagline)}</p></div>`;

const itemsTable = (items) => `<table style="width:100%;border-collapse:collapse;font-size:14px">${items.map((i) =>
  `<tr><td style="padding:6px 0;border-bottom:1px solid #eee">${esc(i.name)}<br><span style="color:#777">${esc(i.color)} / ${esc(i.size)} x ${i.qty}</span></td>
  <td style="text-align:right;border-bottom:1px solid #eee">${money(i.price * i.qty)}</td></tr>`).join('')}</table>`;

function orderConfirmation(order, items, baseUrl) {
  const ship = JSON.parse(order.ship);
  return send({
    to: order.email, subject: `Order ${order.number} confirmed`,
    html: wrap(`Thank you, ${esc(order.name)}! Your order is placed`, `
      <p>Order <b>${order.number}</b> - ${esc(PAY_METHOD[order.payment_method] || order.payment_method)}</p>${itemsTable(items)}
      <p style="text-align:right">Shipping: ${money(order.shipping)}${order.cod_fee ? ` | COD fee: ${money(order.cod_fee)}` : ''}${order.discount ? ` | Discount: -${money(order.discount)}` : ''}<br><b>Total: ${money(order.total)}</b></p>
      <p><b>Ship to:</b><br>${esc(ship.name)}<br>${esc(ship.line1)} ${esc(ship.line2 || '')}<br>${esc(ship.city)}, ${esc(ship.state)} ${esc(ship.pincode)}</p>
      <p><a href="${baseUrl}/track?order=${order.number}">Track your order</a></p>`),
  });
}
function adminNewOrder(order, items) {
  const s = getSettings();
  return send({ to: process.env.ADMIN_NOTIFY_EMAIL || s.email, subject: `New order ${order.number} - ${money(order.total)}`,
    html: wrap('New order received', `<p>${esc(order.name)} (${esc(order.email)}, ${esc(order.phone || '')})<br>${esc(order.payment_method)} / ${order.payment_status}</p>${itemsTable(items)}<p><b>Total ${money(order.total)}</b></p>`) });
}
function statusUpdate(order, baseUrl) {
  return send({ to: order.email, subject: `Order ${order.number}: ${ORDER_STATUS[order.status] || order.status}`,
    html: wrap(`Your order is ${esc(ORDER_STATUS[order.status] || order.status)}`,
      `<p>Order <b>${order.number}</b>${order.carrier ? `<br>Courier: ${esc(order.carrier)}` : ''}${order.tracking_no ? `<br>Tracking no: ${esc(order.tracking_no)}` : ''}</p>
      <p><a href="${baseUrl}/track?order=${order.number}">View order status</a></p>`) });
}
function passwordReset(user, link) {
  return send({ to: user.email, subject: 'Reset your password',
    html: wrap('Reset your password', `<p>Hi ${esc(user.name)}, click the link below to choose a new password. It expires in 1 hour.</p><p><a href="${link}">${link}</a></p><p>If you did not ask for this, ignore this email.</p>`) });
}
function contactNotify(m) {
  const s = getSettings();
  return send({ to: process.env.ADMIN_NOTIFY_EMAIL || s.email, replyTo: m.email, subject: `Website enquiry: ${m.subject || 'New message'}`,
    html: wrap('New website message', `<p><b>${esc(m.name)}</b> (${esc(m.email)} ${esc(m.phone || '')})</p><p>${esc(m.body).replace(/\n/g, '<br>')}</p>`) });
}
module.exports = { send, emailEnabled, orderConfirmation, adminNewOrder, statusUpdate, passwordReset, contactNotify };
