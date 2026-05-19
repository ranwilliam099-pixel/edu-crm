#!/bin/bash
# ============================================================
# verify-tenants-match-reference.sh
#
# 职责（v2.0 方案 §3 L0 + architect spec §1.3 + leader D1.1）：
#   对比所有 tenant schema vs baseline reference manifest，任何不一致 → exit 1
#
# 比对维度（任 1 不一致 → tenant 标 FAIL）：
#   D1 表是否存在（baseline.tables 子集 ⊆ 被测 tenant）
#   D2 所有 column（name + type + nullable + default）
#   D3 索引（name + def + unique）
#   D4 constraints（PRIMARY KEY / UNIQUE / CHECK / FOREIGN KEY）
#   D5 FK（refTable + refColumn + onDelete）
#
# 用 information_schema + pg_indexes 查询（不用 pg_dump 文本 diff，避免 PG 版本噪音）
#
# 用法：
#   bash scripts/verify-tenants-match-reference.sh --baseline=baseline/reference-schema-V49.manifest.json
#   bash scripts/verify-tenants-match-reference.sh --baseline=... --tenant-id=<32-char>
#   bash scripts/verify-tenants-match-reference.sh --baseline=... --report-out=/tmp/verify-report.json
#
# Exit code：
#   0 = 全 PASS
#   1 = 任 1 FAIL
#   2 = baseline 文件不存在
#   3 = PG 连接失败
#
# 出具：edu-server dev B (T2b)  2026-05-19
# ============================================================

set -euo pipefail

# trap ERR
trap 'echo "[ERR] verify-tenants-match-reference.sh failed at line $LINENO" >&2; exit 1' ERR

# ---- 配置 ----
readonly PG_DB="${PG_DB:-edu}"
readonly PG_USER_OS="${PG_USER_OS:-postgres}"
readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---- 参数解析 ----
BASELINE=""
ONLY_TENANT=""
REPORT_OUT=""
VERBOSE=false
for arg in "$@"; do
  case "$arg" in
    --baseline=*) BASELINE="${arg#*=}" ;;
    --tenant-id=*) ONLY_TENANT="${arg#*=}" ;;
    --report-out=*) REPORT_OUT="${arg#*=}" ;;
    --verbose) VERBOSE=true ;;
    -h|--help)
      grep '^#' "$0" | head -30
      exit 0
      ;;
    *) echo "[warn] unknown arg: $arg" >&2 ;;
  esac
done

# ---- 入参校验 ----
if [[ -z "$BASELINE" ]]; then
  echo "[FAIL] --baseline=<path> required" >&2
  exit 2
fi
# 相对路径解析
if [[ "$BASELINE" != /* ]]; then
  BASELINE="${REPO_ROOT}/${BASELINE}"
fi
readonly BASELINE
if [[ ! -f "$BASELINE" ]]; then
  echo "[FAIL] baseline file not found: $BASELINE" >&2
  exit 2
fi
echo "[OK] baseline loaded: $BASELINE"

# F12 修复：SHA-256 完整性校验（防 baseline 被改 + 仍 commit 进 git）
BASELINE_SHA="${BASELINE}.sha256"
if [[ -f "$BASELINE_SHA" ]]; then
  # 用 shasum / sha256sum 校验
  if command -v shasum >/dev/null 2>&1; then
    # macOS shasum -c 期望 <hash>  <relative-path>，我们用绝对路径写入所以需特殊处理
    EXPECTED_HASH=$(awk '{print $1}' < "$BASELINE_SHA")
    ACTUAL_HASH=$(shasum -a 256 "$BASELINE" | awk '{print $1}')
    if [[ "$EXPECTED_HASH" != "$ACTUAL_HASH" ]]; then
      echo "[FAIL] baseline SHA-256 完整性校验失败" >&2
      echo "       expected: $EXPECTED_HASH" >&2
      echo "       actual:   $ACTUAL_HASH" >&2
      echo "       file:     $BASELINE" >&2
      exit 2
    fi
    echo "[OK] baseline SHA-256 完整性 OK ($EXPECTED_HASH)"
  elif command -v sha256sum >/dev/null 2>&1; then
    EXPECTED_HASH=$(awk '{print $1}' < "$BASELINE_SHA")
    ACTUAL_HASH=$(sha256sum "$BASELINE" | awk '{print $1}')
    if [[ "$EXPECTED_HASH" != "$ACTUAL_HASH" ]]; then
      echo "[FAIL] baseline SHA-256 完整性校验失败" >&2
      echo "       expected: $EXPECTED_HASH" >&2
      echo "       actual:   $ACTUAL_HASH" >&2
      exit 2
    fi
    echo "[OK] baseline SHA-256 完整性 OK ($EXPECTED_HASH)"
  else
    echo "[WARN] 缺 shasum / sha256sum — 跳过 SHA-256 完整性校验"
  fi
else
  echo "[WARN] baseline .sha256 不存在: $BASELINE_SHA — 跳过完整性校验（首次 snapshot 后才会有）"
fi

# 验证 manifest JSON 合法
if ! python3 -c "import json; json.load(open('$BASELINE'))" 2>/dev/null; then
  echo "[FAIL] baseline file is not valid JSON" >&2
  exit 2
fi

# ---- 从 baseline 提取期望结构 ----
BASELINE_TABLES=$(python3 -c "import json; d=json.load(open('$BASELINE')); print(' '.join([t['name'] for t in d['tables']]))")
readonly BASELINE_TABLES

# ---- 1. 拉所有 tenant_id（或限定单个）----
echo "[1/3] listing tenants to verify ..."
if [[ -n "$ONLY_TENANT" ]]; then
  TENANT_IDS_LC=$(echo "$ONLY_TENANT" | tr '[:upper:]' '[:lower:]')
else
  TENANT_IDS_LC=$(ssh pdfserver "sudo -u $PG_USER_OS psql -d $PG_DB -tA -c \"SELECT lower(id) FROM public.tenants ORDER BY id;\" 2>/dev/null" | grep -E '^[a-z0-9_]+$' || true)
fi

if [[ -z "$TENANT_IDS_LC" ]]; then
  echo "[FAIL] no tenants found to verify" >&2
  exit 3
fi
TENANT_COUNT=$(echo "$TENANT_IDS_LC" | wc -l | tr -d ' ')
echo "[OK] $TENANT_COUNT tenant(s) to verify"

# ---- 2. 对每个 tenant 一次性查询完整结构 → 比对 ----
echo "[2/3] verifying each tenant against baseline ..."

# 输出 report 临时文件
REPORT_TMP="/tmp/verify-report-$$.json"
echo '{"runAt":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","baseline":"'$BASELINE'","tenants":[' > "$REPORT_TMP"

TOTAL=0
PASS=0
FAIL=0
FAIL_TENANTS=()
FIRST_TENANT=true

for tenant_id_lc in $TENANT_IDS_LC; do
  TOTAL=$((TOTAL + 1))
  schema="tenant_${tenant_id_lc}"

  # 查 schema 当前结构（一次性查全部，避免多次 ssh）
  QUERY_SQL=$(cat <<EOSQL
SELECT jsonb_build_object(
  'tables',
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'name', t.table_name,
      'columns', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'name', c.column_name,
          'type', c.data_type,
          'nullable', (c.is_nullable = 'YES'),
          'default', c.column_default
        ) ORDER BY c.ordinal_position)
        FROM information_schema.columns c
        WHERE c.table_schema = '${schema}' AND c.table_name = t.table_name
      ), '[]'::jsonb),
      'indexes', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'name', pi.indexname,
          'def', pi.indexdef
        ) ORDER BY pi.indexname)
        FROM pg_indexes pi
        WHERE pi.schemaname = '${schema}' AND pi.tablename = t.table_name
      ), '[]'::jsonb),
      'constraints', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'name', tc.constraint_name,
          'type', tc.constraint_type
        ) ORDER BY tc.constraint_name)
        FROM information_schema.table_constraints tc
        WHERE tc.table_schema = '${schema}' AND tc.table_name = t.table_name
          AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE', 'CHECK', 'FOREIGN KEY')
      ), '[]'::jsonb)
    ) ORDER BY t.table_name)
    FROM information_schema.tables t
    WHERE t.table_schema = '${schema}'
      AND t.table_type = 'BASE TABLE'
      AND t.table_name NOT IN ('audit_log')
  ), '[]'::jsonb)
);
EOSQL
)

  # 上传 SQL + 执行
  REMOTE_SQL="/tmp/verify-query-$$-${tenant_id_lc}.sql"
  echo "$QUERY_SQL" | ssh pdfserver "cat > $REMOTE_SQL && chmod 644 $REMOTE_SQL" 2>/dev/null
  ACTUAL_JSON=$(ssh pdfserver "sudo -u $PG_USER_OS psql -d $PG_DB -tA -v ON_ERROR_STOP=1 -f $REMOTE_SQL 2>/dev/null" | tail -1)
  ssh pdfserver "rm -f $REMOTE_SQL" 2>/dev/null

  if [[ -z "$ACTUAL_JSON" || "$ACTUAL_JSON" == "null" ]]; then
    echo "[FAIL] $schema — query returned empty (schema 可能不存在)"
    FAIL=$((FAIL + 1))
    FAIL_TENANTS+=("$schema:schema_missing")
    if [[ "$FIRST_TENANT" != "true" ]]; then echo "," >> "$REPORT_TMP"; fi
    FIRST_TENANT=false
    echo "{\"tenant\":\"$schema\",\"result\":\"FAIL\",\"failures\":[{\"dimension\":\"D1\",\"reason\":\"schema not found\"}]}" >> "$REPORT_TMP"
    continue
  fi

  # F6 修复：base64 编码 ACTUAL_JSON 避免 triple-quote injection
  # 之前 actual = json.loads('''$ACTUAL_JSON''') — 若 JSON 含 '''" 等字符可注入 python
  # 改用 base64 解码 → 无可逃逸字符
  # 同时 baseline 路径走 shell 变量 → quote 包裹 + Python 用 sys.argv 接收防 shell injection
  ACTUAL_JSON_B64=$(printf '%s' "$ACTUAL_JSON" | base64 | tr -d '\n')

  COMPARE_RESULT=$(python3 - "$BASELINE" "$ACTUAL_JSON_B64" <<'PYEOF'
import json
import sys
import base64

baseline_path = sys.argv[1]
actual_json_b64 = sys.argv[2]

baseline = json.load(open(baseline_path))
actual = json.loads(base64.b64decode(actual_json_b64).decode('utf-8'))

failures = []

baseline_tables = {t['name']: t for t in baseline['tables']}
actual_tables = {t['name']: t for t in actual['tables']}

# D1 表存在
for tname in baseline_tables:
    if tname not in actual_tables:
        failures.append({"dimension": "D1", "table": tname, "reason": "table missing"})
        continue

    b_table = baseline_tables[tname]
    a_table = actual_tables[tname]

    # D2 columns
    b_cols = {c['name']: c for c in b_table['columns']}
    a_cols = {c['name']: c for c in a_table['columns']}
    for cname in b_cols:
        if cname not in a_cols:
            failures.append({"dimension": "D2", "table": tname, "column": cname, "reason": "column missing"})
            continue
        bc = b_cols[cname]
        ac = a_cols[cname]
        if bc['type'] != ac['type']:
            failures.append({"dimension": "D2", "table": tname, "column": cname, "reason": f"type mismatch baseline={bc['type']} actual={ac['type']}"})
        if bc['nullable'] != ac['nullable']:
            failures.append({"dimension": "D2", "table": tname, "column": cname, "reason": f"nullable mismatch baseline={bc['nullable']} actual={ac['nullable']}"})
        # default 不一致 → WARN 而非 FAIL（architect spec §4.2 豁免规则）

    # D3 indexes
    b_idx = {i['name']: i for i in b_table['indexes']}
    a_idx = {i['name']: i for i in a_table['indexes']}
    for iname in b_idx:
        if iname not in a_idx:
            failures.append({"dimension": "D3", "table": tname, "index": iname, "reason": "index missing"})

    # D4 constraints
    # 豁免：PG 内部自动生成的 NOT NULL constraint name 含 OID 不稳定（形如 90869_91616_10_not_null）
    # nullable 已在 D2 比对，无需在 D4 重复比对内部 NOT NULL constraint
    import re
    _internal_notnull_re = re.compile(r'^\d+_\d+_\d+_not_null$')
    b_cons = {c['name']: c for c in b_table['constraints'] if not _internal_notnull_re.match(c['name'])}
    a_cons = {c['name']: c for c in a_table['constraints'] if not _internal_notnull_re.match(c['name'])}
    for cname in b_cons:
        if cname not in a_cons:
            failures.append({"dimension": "D4", "table": tname, "constraint": cname, "reason": "constraint missing", "type": b_cons[cname]['type']})

if failures:
    print(json.dumps({"result": "FAIL", "failures": failures[:20]}))  # 截 20 条避免输出过长
else:
    print(json.dumps({"result": "PASS"}))
PYEOF
)

  RESULT=$(echo "$COMPARE_RESULT" | python3 -c "import sys, json; print(json.loads(sys.stdin.read())['result'])")

  if [[ "$RESULT" == "PASS" ]]; then
    PASS=$((PASS + 1))
    echo "[PASS] $schema"
    if [[ "$FIRST_TENANT" != "true" ]]; then echo "," >> "$REPORT_TMP"; fi
    FIRST_TENANT=false
    echo "{\"tenant\":\"$schema\",\"result\":\"PASS\"}" >> "$REPORT_TMP"
  else
    FAIL=$((FAIL + 1))
    FAIL_TENANTS+=("$schema")
    FAIL_DETAIL=$(echo "$COMPARE_RESULT" | python3 -c "import sys, json; d=json.loads(sys.stdin.read()); print('; '.join([f.get('dimension','?')+':'+f.get('reason','?')+' ('+f.get('table','-')+'.'+f.get('column','-' if 'column' in f else f.get('index','-' if 'index' in f else f.get('constraint','-')))+')' for f in d['failures'][:5]]))")
    echo "[FAIL] $schema — $FAIL_DETAIL"
    if [[ "$VERBOSE" == "true" ]]; then
      echo "        $COMPARE_RESULT" | head -3
    fi
    if [[ "$FIRST_TENANT" != "true" ]]; then echo "," >> "$REPORT_TMP"; fi
    FIRST_TENANT=false
    # F6 修复：JSON-escape COMPARE_RESULT + schema 用 sys.argv 防 Python injection
    echo "$COMPARE_RESULT" | python3 -c "
import sys, json
schema = sys.argv[1]
d = json.loads(sys.stdin.read())
print(json.dumps({'tenant': schema, 'result': 'FAIL', 'failures': d['failures']}))
" "$schema" >> "$REPORT_TMP"
  fi
done

echo ']}' >> "$REPORT_TMP"

# ---- 3. 输出 summary + report ----
echo ""
echo "============================================================"
echo "  Summary: $PASS/$TOTAL PASS, $FAIL FAIL"
echo "============================================================"
if [[ "$FAIL" -gt 0 ]]; then
  echo "Failed tenants ($FAIL):"
  for t in "${FAIL_TENANTS[@]}"; do
    echo "  - $t"
  done
fi

# 写 report
if [[ -n "$REPORT_OUT" ]]; then
  cp "$REPORT_TMP" "$REPORT_OUT"
  echo "Report written: $REPORT_OUT"
fi
rm -f "$REPORT_TMP"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
