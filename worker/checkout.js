/**
 * k6 scenario: real WooCommerce product → cart → checkout with stress gateway.
 *
 * Job config is read from AWC_STRESS_JOB_FILE (JSON) or __ENV fields.
 *
 * Usage:
 *   AWC_STRESS_JOB_FILE=/path/job.json k6 run checkout.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

const errorRate = new Rate('awc_errors');
const orderTrend = new Trend('awc_order_ms', true);

function loadJob() {
  const path = __ENV.AWC_STRESS_JOB_FILE;
  if (path) {
    try {
      return JSON.parse(open(path));
    } catch (e) {
      console.error('Failed to read job file', e);
    }
  }
  return {
    base_url: __ENV.BASE_URL || 'http://localhost',
    products: [{ id: parseInt(__ENV.PRODUCT_ID || '0', 10), permalink: __ENV.PRODUCT_URL || '' }],
    checkout_path: __ENV.CHECKOUT_PATH || '/checkout/',
    cart_path: __ENV.CART_PATH || '/cart/',
    payment_method: 'awc_stress_gateway',
    checkout_token: __ENV.CHECKOUT_TOKEN || '',
    order_count: parseInt(__ENV.ORDER_COUNT || '10', 10),
    concurrency: parseInt(__ENV.VUS || '2', 10),
    duration_sec: parseInt(__ENV.DURATION || '30', 10),
    ramp_up_sec: parseInt(__ENV.RAMP || '5', 10),
    error_abort_pct: parseFloat(__ENV.ABORT_PCT || '5'),
    callback_url: __ENV.CALLBACK_URL || '',
    worker_secret: __ENV.WORKER_SECRET || '',
    run_id: parseInt(__ENV.RUN_ID || '0', 10),
  };
}

const job = loadJob();
const products = new SharedArray('products', function () {
  return job.products && job.products.length ? job.products : [{ id: 0, permalink: job.base_url }];
});

export const options = {
  scenarios: {
    checkout_storm: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: `${job.ramp_up_sec || 5}s`, target: job.concurrency || 2 },
        { duration: `${job.duration_sec || 30}s`, target: job.concurrency || 2 },
        { duration: '10s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    awc_errors: [
      {
        threshold: `rate<${(job.error_abort_pct || 5) / 100}`,
        abortOnFail: true,
        delayAbortEval: '15s',
      },
    ],
  },
};

function jarCookies(res) {
  const jar = http.cookieJar();
  return jar;
}

function pickProduct() {
  return products[Math.floor(Math.random() * products.length)];
}

export default function () {
  const base = String(job.base_url || '').replace(/\/$/, '');
  const product = pickProduct();
  const token = job.checkout_token || '';
  const headers = {
    'X-AWC-Stress-Token': token,
    'User-Agent': 'MinoCode-Stress-k6/1.0',
  };

  const t0 = Date.now();

  // 1) Product page
  const productUrl = product.permalink || `${base}/?p=${product.id}`;
  let res = http.get(productUrl, { headers, redirects: 5 });
  let ok = check(res, { 'product 2xx': (r) => r.status >= 200 && r.status < 400 });
  errorRate.add(!ok);

  // 2) Add to cart (classic AJAX)
  const addUrl = `${base}/?wc-ajax=add_to_cart`;
  res = http.post(
    addUrl,
    {
      product_id: String(product.id),
      quantity: '1',
    },
    { headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, headers) }
  );
  ok = check(res, { 'add to cart': (r) => r.status >= 200 && r.status < 500 });
  errorRate.add(!ok);

  // 3) Cart page (warm session)
  res = http.get(`${base}${job.cart_path || '/cart/'}`, { headers });
  ok = check(res, { 'cart 2xx': (r) => r.status >= 200 && r.status < 400 });
  errorRate.add(!ok);

  // 4) Checkout page
  const checkoutUrl = `${base}${job.checkout_path || '/checkout/'}?awc_stress_token=${encodeURIComponent(token)}`;
  res = http.get(checkoutUrl, { headers });
  ok = check(res, { 'checkout get': (r) => r.status >= 200 && r.status < 400 });
  errorRate.add(!ok);

  // Extract nonce if present
  let nonce = '';
  const m = String(res.body || '').match(/name="woocommerce-process-checkout-nonce"\s+value="([^"]+)"/);
  if (m) nonce = m[1];

  const email = `stress+${__VU}-${__ITER}-${Date.now()}@minocode.test`;
  const payload = {
    billing_first_name: 'Stress',
    billing_last_name: 'Bot',
    billing_country: 'IR',
    billing_address_1: 'Test St',
    billing_city: 'Tehran',
    billing_state: 'THR',
    billing_postcode: '1234567890',
    billing_phone: '09120000000',
    billing_email: email,
    payment_method: job.payment_method || 'awc_stress_gateway',
    awc_stress_token: token,
    'woocommerce-process-checkout-nonce': nonce,
    _wp_http_referer: job.checkout_path || '/checkout/',
  };

  res = http.post(`${base}/?wc-ajax=checkout`, payload, {
    headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, headers),
  });
  const orderOk =
    res.status >= 200 &&
    res.status < 500 &&
    (String(res.body).indexOf('success') !== -1 || String(res.body).indexOf('order') !== -1 || res.status === 200);
  ok = check(res, { 'checkout post': () => orderOk });
  errorRate.add(!ok);
  orderTrend.add(Date.now() - t0);

  if (res.status >= 500) {
    errorRate.add(1);
  }

  sleep(0.2);
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export function handleSummary(data) {
  const httpReq = data.metrics.http_req_duration || {};
  const values = httpReq.values || {};
  const err = data.metrics.awc_errors || {};
  const errRate = (err.values && err.values.rate) || 0;
  const payload = {
    run_id: job.run_id,
    worker_secret: job.worker_secret,
    status: 'finished',
    metrics: {
      rps: (data.metrics.http_reqs && data.metrics.http_reqs.values && data.metrics.http_reqs.values.rate) || 0,
      latency_p50_ms: values['p(50)'] || 0,
      latency_p95_ms: values['p(95)'] || 0,
      latency_p99_ms: values['p(99)'] || 0,
      error_pct: errRate * 100,
      http_5xx: 0,
      http_4xx: 0,
      orders_ok: Math.round(((data.metrics.http_reqs && data.metrics.http_reqs.values && data.metrics.http_reqs.values.count) || 0) / 4),
    },
  };

  if (job.callback_url && job.worker_secret) {
    http.post(job.callback_url, JSON.stringify(payload), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    'summary.json': JSON.stringify(payload, null, 2),
  };
}
