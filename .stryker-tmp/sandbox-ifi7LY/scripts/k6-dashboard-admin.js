// ============================================================
// k6-dashboard-admin.js — T13 PgBouncer 升级压测 scenario
//
// 来源：spec 2026-05-16-T13-pgbouncer-spec.md §6
// 目标 endpoint：GET /api/db/dashboards/admin (dashboard.controller.ts:42)
// 验收：P95 < 200ms / http_req_failed < 1%
// ============================================================
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '5s',  target: 10 },
    { duration: '20s', target: 50 },
    { duration: '5s',  target: 50 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<200'],
    http_req_failed:   ['rate<0.01'],
  },
};

const TARGET = __ENV.TARGET || 'http://1.14.127.67';
const TOKEN  = __ENV.TOKEN  || '';
const TENANT = __ENV.TENANT || 'tenant_demo';

export default function () {
  const res = http.get(`${TARGET}/api/db/dashboards/admin`, {
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'x-tenant-schema': TENANT,
    },
    tags: { endpoint: 'admin-kpi' },
  });
  check(res, {
    'status 200': (r) => r.status === 200,
    'has kpi data': (r) => r.body && r.body.length > 10,
  });
  sleep(0.5);
}
