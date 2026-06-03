-- ============================================================
-- V68__lesson_feedback_attachments.sql
-- 老师课后反馈 — 反馈级图片附件（家长可见）— lesson_feedbacks 新增列（tenant schema）
-- 占位：`__TENANT_SCHEMA__` 由 backfill 脚本 sed 替换（tenant-schema migration）
--
-- 来源：SSOT §3.-2 走查续批 III（2026-06-03 用户拍板：老师反馈支持「选微信聊天记录」上传）
--
-- 业务（老师线，家长可见）：
--   老师填反馈页 b/feedback/new 新增附件区——wx.chooseMessageFile 从微信会话多选图片
--   （聊天记录截图）→ uploadFile 传 nginx OSS → 逐张 imgSecCheck 内容安全 → 随反馈提交落库。
--   可见性 = 家长可见（反馈级）：附件作为反馈的一部分随反馈推家长 C 端看。
--
-- ⚠️ 与既有 homework_attachments（V18 前）是**两个独立语义字段**：
--    homework_attachments = 作业附件（老师布置作业的素材）；
--    本 V68 feedback_attachments = 反馈级图片附件（聊天记录截图，家长可见）。
--    **不复用**，避免语义混淆。
--
-- ⚠️ 可见性与 teacher_internal_note（老师内部备注）相反：
--    teacher_internal_note 按 role 剥离，家长 / 销售不可见；
--    feedback_attachments **对所有 role 都保留不剥离**（家长可见，maskFeedbackForRole 不动它）。
--
-- 字段：
--   feedback_attachments JSONB NULL — [{ url, type:'image', filename }]
--     （复用 homework_submission attachments shape；后端校验 url 为 https 或本机 OSS 域，
--      非法整条丢弃不报错；上限 9 张）
--
-- 可逆（回退）：ALTER TABLE __TENANT_SCHEMA__.lesson_feedbacks DROP COLUMN IF EXISTS feedback_attachments;
--
-- 幂等：ADD COLUMN IF NOT EXISTS（重跑无害）；无数据 backfill（既存反馈默认 NULL → 应用层 map 成 []）。
--
-- ⚠️ migration 不在 prod 自动跑，待用户「部署」（SSOT §3.-2）。
-- ============================================================

BEGIN;

SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- ----------------------------------------------------------------
-- lesson_feedbacks.feedback_attachments — 反馈级图片附件（家长可见）
-- ----------------------------------------------------------------
ALTER TABLE lesson_feedbacks
  ADD COLUMN IF NOT EXISTS feedback_attachments JSONB;

COMMENT ON COLUMN lesson_feedbacks.feedback_attachments IS
  'V68 (SSOT §3.-2 2026-06-03) 反馈级图片附件（家长可见）— [{url,type:image,filename}]；老师从微信会话选聊天记录截图随反馈提交，逐张 imgSecCheck；与 homework_attachments（作业附件）独立；与 teacher_internal_note 相反，对所有 role 不剥离（家长可见）';

COMMIT;
