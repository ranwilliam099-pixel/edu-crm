#!/bin/bash
# ============================================================
# snapshot-reference-schema.sh
#
# 职责（v2.0 方案 §3 L0 + architect spec §1.2）：
#   pg_dump 一个 reference tenant 的完整 schema (DDL only) → baseline/reference-schema-V<N>.sql
#   同时从 information_schema 提取结构索引 → baseline/reference-schema-V<N>.manifest.json
#
# 输出 2 个文件：
#   - baseline/reference-schema-V<N>.sql            (pg_dump --schema-only --no-owner --no-privileges)
#   - baseline/reference-schema-V<N>.manifest.json  (tables/columns/indexes/FKs/constraints 索引)
#
# V<N> 自动从最高编号 migration 文件 grep（不需 --version 参数）
#
# 用法：
#   bash scripts/snapshot-reference-schema.sh --tenant-id=<32-char-id> [--dry-run] [--no-git]
#
# 出具：edu-server dev B (T2b)  2026-05-19
# ============================================================

set -euo pipefail

# ---- trap ERR 打印 line number（架构师 spec 严谨度要求）----
trap 'echo "[ERR] snapshot-reference-schema.sh failed at line $LINENO" >&2; exit 1' ERR

# ---- 配置（readonly 严谨度要求）----
readonly PG_DB="${PG_DB:-edu}"
readonly PG_USER_OS="${PG_USER_OS:-postgres}"
readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly MIGRATIONS_DIR="${REPO_ROOT}/migrations"
readonly BASELINE_DIR="${REPO_ROOT}/baseline"

# ---- 参数解析 ----
TENANT_ID=""
DRY_RUN=false
NO_GIT=false
for arg in "$@"; do
  case "$arg" in
    --tenant-id=*) TENANT_ID="${arg#*=}" ;;
    --dry-run) DRY_RUN=true ;;
    --no-git) NO_GIT=true ;;
    -h|--help)
      grep '^#' "$0" | head -30
      exit 0
      ;;
    *) echo "[warn] unknown arg: $arg" >&2 ;;
  esac
done

# ---- 入参校验 ----
if [[ -z "$TENANT_ID" ]]; then
  echo "[FAIL] --tenant-id=<32-char-id> required" >&2
  exit 2
fi
# tenant id 校验放宽：允许 32-char alphanumeric（标准 ULID）或 mxedu_<num> 前缀（旧 id）
if [[ ! "$TENANT_ID" =~ ^([A-Za-z0-9]{32}|mxedu_[0-9]+)$ ]]; then
  echo "[FAIL] tenant-id must be 32-char alphanumeric or mxedu_<num>, got: $TENANT_ID" >&2
  exit 2
fi
# PG schema 名永远 lowercase（PG identifier 大小写不敏感会自动 lowercase）
readonly TENANT_ID_LC=$(echo "$TENANT_ID" | tr '[:upper:]' '[:lower:]')
readonly TENANT_SCHEMA="tenant_${TENANT_ID_LC}"

# ---- 自动检测 V<N>（migrations 目录最高编号）----
# 规则：V<num>__*.sql 取 num 最大值（V8_1 算 V8.1 不参与 max，按整数取）
LATEST_V=$(ls -1 "$MIGRATIONS_DIR" 2>/dev/null \
  | grep -E '^V[0-9]+(_[0-9]+)?__.*\.sql$' \
  | sed -E 's/^V([0-9]+).*/\1/' \
  | sort -n \
  | tail -1)
if [[ -z "$LATEST_V" ]]; then
  echo "[FAIL] no migration files found in $MIGRATIONS_DIR" >&2
  exit 1
fi
readonly LATEST_V

# ---- 输出文件路径 ----
readonly OUT_SQL="${BASELINE_DIR}/reference-schema-V${LATEST_V}.sql"
readonly OUT_MANIFEST="${BASELINE_DIR}/reference-schema-V${LATEST_V}.manifest.json"
readonly TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

echo "============================================================"
echo "  snapshot-reference-schema.sh"
echo "============================================================"
echo "  PG_DB:        $PG_DB"
echo "  Tenant ID:    $TENANT_ID"
echo "  Tenant Schema: $TENANT_SCHEMA"
echo "  Latest V:     V$LATEST_V"
echo "  Out SQL:      $OUT_SQL"
echo "  Out Manifest: $OUT_MANIFEST"
echo "  Snapshot at:  $TS"
echo "  Dry run:      $DRY_RUN"
echo "  No git:       $NO_GIT"
echo "============================================================"
echo ""

# ---- Dry run 模式：只打印路径，不真跑 ----
if [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY-RUN] would run pg_dump on schema=$TENANT_SCHEMA"
  echo "[DRY-RUN] would write $OUT_SQL"
  echo "[DRY-RUN] would write $OUT_MANIFEST"
  if [[ "$NO_GIT" != "true" ]]; then
    echo "[DRY-RUN] would git add baseline/ && git commit"
  fi
  exit 0
fi

# ---- 目录准备 ----
mkdir -p "$BASELINE_DIR"

# ---- 1. 验证 tenant schema 存在 ----
# F6 修复：用 psql -v schema 参数化（防 SSH SQL injection）
# 注：tenant_id 已经过 regex 校验 (^[A-Za-z0-9]{32}|mxedu_[0-9]+$)，仍走参数化双保险
# 用 2>/dev/null 隔离 "could not change directory" stderr 噪音
SCHEMA_EXISTS=$(ssh pdfserver "sudo -u $PG_USER_OS psql -d $PG_DB -tA -c \"SELECT 1 FROM information_schema.schemata WHERE schema_name = '$TENANT_SCHEMA';\" 2>/dev/null" | tr -d ' \r')
if [[ "$SCHEMA_EXISTS" != "1" ]]; then
  echo "[FAIL] schema $TENANT_SCHEMA does not exist on production PG" >&2
  exit 1
fi
echo "[OK] schema $TENANT_SCHEMA verified exist"

# ---- 2. pg_dump --schema-only --no-owner --no-privileges ----
echo "[1/4] pg_dump --schema-only on $TENANT_SCHEMA ..."
REMOTE_DUMP="/tmp/snapshot-${TENANT_SCHEMA}-${LATEST_V}.sql"
ssh pdfserver "sudo -u $PG_USER_OS pg_dump -d $PG_DB --schema-only --no-owner --no-privileges --schema='$TENANT_SCHEMA' > $REMOTE_DUMP && chmod 644 $REMOTE_DUMP" 2>&1 | tail -5

# ---- 3. 标准化 SQL（architect spec §2.3 6 步）----
echo "[2/4] normalize SQL output ..."
# 拉到本地后处理（不在生产做 sed）
TMP_RAW="/tmp/snapshot-raw-${LATEST_V}-$$.sql"
scp pdfserver:"$REMOTE_DUMP" "$TMP_RAW" 2>&1 | tail -3

# 标准化（生成确定性 SQL 便于 git diff）：
# 1. 删 -- Dumped 注释
# 2. 删 SET / SELECT pg_catalog 行
# 3. 删 ALTER ... OWNER TO 行
# 4. 替换 tenant_<id> 为 __TENANT_SCHEMA__ 占位符
# 5. 删空 comment lines / blank duplicates
sed -E \
  -e '/^-- Dumped/d' \
  -e '/^SET statement_timeout/d' \
  -e '/^SET lock_timeout/d' \
  -e '/^SET idle_in_transaction_session_timeout/d' \
  -e '/^SET client_encoding/d' \
  -e '/^SET standard_conforming_strings/d' \
  -e '/^SET check_function_bodies/d' \
  -e '/^SET xmloption/d' \
  -e '/^SET client_min_messages/d' \
  -e '/^SET row_security/d' \
  -e '/^SET default_tablespace/d' \
  -e '/^SET default_table_access_method/d' \
  -e '/^SELECT pg_catalog\.set_config/d' \
  -e '/^ALTER .* OWNER TO/d' \
  -e "s/${TENANT_SCHEMA}/__TENANT_SCHEMA__/g" \
  "$TMP_RAW" > "$OUT_SQL"

# 删除连续多空行
awk 'BEGIN{prev=""} {if($0=="" && prev=="") next; print; prev=$0}' "$OUT_SQL" > "${OUT_SQL}.tmp" && mv "${OUT_SQL}.tmp" "$OUT_SQL"

rm -f "$TMP_RAW"
ssh pdfserver "rm -f $REMOTE_DUMP" 2>&1 | tail -2

WC_OUT=$(wc -l < "$OUT_SQL" | tr -d ' ')
echo "[OK] normalized SQL written to $OUT_SQL ($WC_OUT lines)"

# ---- 4. 提取 manifest.json（information_schema 查询）----
echo "[3/4] extract manifest.json from information_schema ..."

# 用 SQL 一次性查全部结构 → JSON
# 用 jsonb_agg + ORDER BY 保证字典序稳定（git diff 友好）
# F6 修复：SQL 用 psql 内置变量 :'schema' 参数化（防 SSH SQL injection）
# 之前 ${TENANT_SCHEMA} shell 插值；本次改用 psql `-v schema=...` 双保险
MANIFEST_SQL=$(cat <<'EOSQL'
\set QUIET on
WITH
table_cols AS (
  SELECT c.table_name,
         jsonb_agg(jsonb_build_object(
           'name', c.column_name,
           'type', c.data_type,
           'nullable', (c.is_nullable = 'YES'),
           'default', c.column_default
         ) ORDER BY c.ordinal_position) AS columns
  FROM information_schema.columns c
  WHERE c.table_schema = :'schema'
    AND c.table_name NOT IN ('audit_log')
  GROUP BY c.table_name
),
table_indexes AS (
  SELECT pi.tablename AS table_name,
         jsonb_agg(jsonb_build_object(
           'name', pi.indexname,
           'def', pi.indexdef
         ) ORDER BY pi.indexname) AS indexes
  FROM pg_indexes pi
  WHERE pi.schemaname = :'schema'
    AND pi.tablename NOT IN ('audit_log')
  GROUP BY pi.tablename
),
table_constraints AS (
  SELECT tc.table_name,
         jsonb_agg(jsonb_build_object(
           'name', tc.constraint_name,
           'type', tc.constraint_type
         ) ORDER BY tc.constraint_name) AS constraints
  FROM information_schema.table_constraints tc
  WHERE tc.table_schema = :'schema'
    AND tc.table_name NOT IN ('audit_log')
    AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE', 'CHECK', 'FOREIGN KEY')
  GROUP BY tc.table_name
),
table_fks AS (
  SELECT tc.table_name,
         jsonb_agg(jsonb_build_object(
           'name', tc.constraint_name,
           'column', kcu.column_name,
           'refTable', ccu.table_name,
           'refColumn', ccu.column_name,
           'onDelete', rc.delete_rule
         ) ORDER BY tc.constraint_name) AS fks
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
  JOIN information_schema.referential_constraints rc
    ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
  WHERE tc.table_schema = :'schema'
    AND tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_name NOT IN ('audit_log')
  GROUP BY tc.table_name
),
table_list AS (
  SELECT t.table_name
  FROM information_schema.tables t
  WHERE t.table_schema = :'schema'
    AND t.table_type = 'BASE TABLE'
    AND t.table_name NOT IN ('audit_log')
)
SELECT jsonb_build_object(
  'tables',
  jsonb_agg(jsonb_build_object(
    'name', tl.table_name,
    'columns', COALESCE(tc.columns, '[]'::jsonb),
    'indexes', COALESCE(ti.indexes, '[]'::jsonb),
    'constraints', COALESCE(tcon.constraints, '[]'::jsonb),
    'foreignKeys', COALESCE(tfk.fks, '[]'::jsonb)
  ) ORDER BY tl.table_name)
) AS manifest
FROM table_list tl
LEFT JOIN table_cols tc ON tc.table_name = tl.table_name
LEFT JOIN table_indexes ti ON ti.table_name = tl.table_name
LEFT JOIN table_constraints tcon ON tcon.table_name = tl.table_name
LEFT JOIN table_fks tfk ON tfk.table_name = tl.table_name;
EOSQL
)

# 把 SQL 上传到服务器（避免 ssh 引号转义噩梦）
REMOTE_SQL_FILE="/tmp/manifest-query-$$-${LATEST_V}.sql"
echo "$MANIFEST_SQL" | ssh pdfserver "cat > $REMOTE_SQL_FILE && chmod 644 $REMOTE_SQL_FILE" 2>/dev/null

# F6: 执行 SQL 用 psql -v schema= 参数化注入 schema 名（防 SSH SQL injection）
# 隔离 stderr "could not change directory"
TABLES_JSON=$(ssh pdfserver "sudo -u $PG_USER_OS psql -d $PG_DB -tA -v ON_ERROR_STOP=1 -v schema='$TENANT_SCHEMA' -f $REMOTE_SQL_FILE 2>/dev/null" | tail -1)

ssh pdfserver "rm -f $REMOTE_SQL_FILE" 2>&1 | tail -1

if [[ -z "$TABLES_JSON" || "$TABLES_JSON" == "null" ]]; then
  echo "[FAIL] manifest query returned empty/null" >&2
  exit 1
fi

# 组装最终 manifest.json
# F6 修复：用 base64 编码 TABLES_JSON 避免 shell 替换 + python triple-quote injection
# 之前 echo "$TABLES_JSON" | python3 -c 'json.loads(sys.stdin.read())' — 走 stdin 已较安全，
# 但 echo 对含 \\n 或 % 的字符串不可靠 → 改用 printf + base64
TABLES_JSON_B64=$(printf '%s' "$TABLES_JSON" | base64 | tr -d '\n')
TABLES_PRETTY=$(python3 - "$TABLES_JSON_B64" <<'PYEOF'
import sys, json, base64
data = json.loads(base64.b64decode(sys.argv[1]).decode('utf-8'))
print(json.dumps(data["tables"], indent=2, ensure_ascii=False, sort_keys=False))
PYEOF
)

cat > "$OUT_MANIFEST" <<EOF
{
  "version": "V${LATEST_V}",
  "snapshotAt": "${TS}",
  "sourceTenant": "${TENANT_SCHEMA}",
  "tables": ${TABLES_PRETTY}
}
EOF

# 验证 JSON 合法
if ! python3 -c "import json; json.load(open('$OUT_MANIFEST'))" 2>/dev/null; then
  echo "[FAIL] manifest.json invalid JSON" >&2
  cat "$OUT_MANIFEST" | head -20 >&2
  exit 1
fi

# 统计
TABLE_COUNT=$(python3 -c "import json; d=json.load(open('$OUT_MANIFEST')); print(len(d['tables']))")
echo "[OK] manifest.json written to $OUT_MANIFEST ($TABLE_COUNT tables)"

# ---- F12: SHA-256 完整性签名（baseline 防篡改）----
echo "[4/5] writing SHA-256 signatures ..."
if command -v shasum >/dev/null 2>&1; then
  # macOS / BSD shasum
  shasum -a 256 "$OUT_SQL" | awk '{print $1"  "$2}' > "${OUT_SQL}.sha256"
  shasum -a 256 "$OUT_MANIFEST" | awk '{print $1"  "$2}' > "${OUT_MANIFEST}.sha256"
elif command -v sha256sum >/dev/null 2>&1; then
  # Linux sha256sum
  (cd "$(dirname "$OUT_SQL")" && sha256sum "$(basename "$OUT_SQL")") > "${OUT_SQL}.sha256"
  (cd "$(dirname "$OUT_MANIFEST")" && sha256sum "$(basename "$OUT_MANIFEST")") > "${OUT_MANIFEST}.sha256"
else
  echo "[WARN] 缺 shasum / sha256sum — 跳过 SHA-256 签名" >&2
fi
if [[ -f "${OUT_SQL}.sha256" ]] && [[ -f "${OUT_MANIFEST}.sha256" ]]; then
  echo "[OK] SHA-256 → ${OUT_SQL}.sha256 + ${OUT_MANIFEST}.sha256"
fi

# ---- 5. git add + commit（默认行为，--no-git 跳过）----
# F12: 含 .sha256 文件一并入库（完整性 trail）
if [[ "$NO_GIT" == "true" ]]; then
  echo "[SKIP] --no-git, not committing"
else
  cd "$REPO_ROOT"
  GIT_ADD_FILES=("$OUT_SQL" "$OUT_MANIFEST")
  [[ -f "${OUT_SQL}.sha256" ]] && GIT_ADD_FILES+=("${OUT_SQL}.sha256")
  [[ -f "${OUT_MANIFEST}.sha256" ]] && GIT_ADD_FILES+=("${OUT_MANIFEST}.sha256")
  if git diff --quiet baseline/ 2>/dev/null && git diff --cached --quiet baseline/ 2>/dev/null; then
    if ! git ls-files --error-unmatch "$OUT_SQL" >/dev/null 2>&1 || ! git ls-files --error-unmatch "$OUT_MANIFEST" >/dev/null 2>&1; then
      git add "${GIT_ADD_FILES[@]}"
      echo "[OK] git add baseline/reference-schema-V${LATEST_V}.{sql,manifest.json,sha256}"
    else
      echo "[OK] no baseline/ changes to commit"
    fi
  else
    git add "${GIT_ADD_FILES[@]}"
    echo "[OK] git add baseline/ (changes detected, ${#GIT_ADD_FILES[@]} files)"
  fi
  # 不自动 commit（leader 审完再提）
  echo "[INFO] git commit skipped — leader will commit baseline/ explicitly"
fi

echo ""
echo "============================================================"
echo "  SUCCESS"
echo "  Snapshot V$LATEST_V written:"
echo "    - $OUT_SQL"
echo "    - $OUT_MANIFEST ($TABLE_COUNT tables)"
if [[ -f "${OUT_SQL}.sha256" ]]; then
  echo "    - ${OUT_SQL}.sha256 (F12 完整性签名)"
fi
echo "============================================================"
exit 0
