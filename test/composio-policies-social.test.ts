import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyComposioTool, loadPolicies, parsePolicy } from "../src/sources/composio/policy.ts";

// C373 Jarvis: curated policies for the social, ads, messaging, CRM, sheets and WordPress.com toolkits.
// Slugs are real Composio slugs (`composio tools list <toolkit>`, 2026-10-27).
const policies = loadPolicies();

const expect = (toolkit: string, rows: ReadonlyArray<readonly [string, string]>) => {
  const policy = policies.get(toolkit);
  assert.ok(policy, toolkit);
  for (const [slug, effect] of rows) assert.equal(classifyComposioTool(slug, policy).effect, effect, slug);
};

test("Jarvis: public uploads and publishing are outward (name inference said write)", () => {
  expect("youtube", [["YOUTUBE_UPLOAD_VIDEO", "outward"], ["YOUTUBE_MULTIPART_UPLOAD_VIDEO", "outward"], ["YOUTUBE_UPDATE_VIDEO", "outward"], ["YOUTUBE_UPDATE_THUMBNAIL", "outward"]]);
  expect("tiktok", [["TIKTOK_UPLOAD_VIDEO", "outward"], ["TIKTOK_UPLOAD_VIDEOS", "outward"], ["TIKTOK_PUBLISH_VIDEO", "outward"], ["TIKTOK_POST_PHOTO", "outward"]]);
  expect("facebook", [["FACEBOOK_UPLOAD_VIDEO", "outward"], ["FACEBOOK_UPLOAD_PHOTO", "outward"], ["FACEBOOK_CREATE_POST", "outward"], ["FACEBOOK_ASSIGN_PAGE_TASK", "outward"]]);
  expect("instagram", [["INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH", "outward"], ["INSTAGRAM_CREATE_MEDIA_CONTAINER", "write"], ["INSTAGRAM_CREATE_CAROUSEL_CONTAINER", "write"]]);
});

test("Jarvis: ad spend changes are money (name inference said write)", () => {
  expect("metaads", [
    ["METAADS_CREATE_CAMPAIGN", "money"], ["METAADS_UPDATE_CAMPAIGN", "money"], ["METAADS_CREATE_AD_SET", "money"], ["METAADS_CREATE_AD", "money"],
    ["METAADS_COPY_AD_OBJECT", "money"], ["METAADS_CREATE_AD_CREATIVE", "write"], ["METAADS_UPLOAD_AD_IMAGE", "write"], ["METAADS_CREATE_CUSTOM_AUDIENCE", "outward"],
    ["METAADS_DELETE_CAMPAIGN", "destructive"], ["METAADS_GET_INSIGHTS", "read"], ["METAADS_GENERATE_AD_PREVIEWS", "read"], ["METAADS_LIST_CAMPAIGNS", "read"],
  ]);
  expect("tiktok_ads", [
    ["TIKTOK_ADS_CREATE_CAMPAIGN", "money"], ["TIKTOK_ADS_UPDATE_ADGROUP_BUDGET", "money"], ["TIKTOK_ADS_UPDATE_AD_STATUS", "money"], ["TIKTOK_ADS_CREATE_SMART_PLUS_CAMPAIGN", "money"],
    ["TIKTOK_ADS_BIND_OPTIMIZER_RULE_BATCH", "money"], ["TIKTOK_ADS_UPDATE_COMMENT_STATUS", "outward"], ["TIKTOK_ADS_REPLY_TO_COMMENT", "outward"], ["TIKTOK_ADS_SHARE_CUSTOM_AUDIENCES", "outward"],
    ["TIKTOK_ADS_CHECK_CAMPAIGN_COPY_TASK", "read"], ["TIKTOK_ADS_RECOMMEND_BID", "read"], ["TIKTOK_ADS_GET_REPORT_INTEGRATED", "read"], ["TIKTOK_ADS_DELETE_COMMENT", "destructive"],
    ["TIKTOK_ADS_UPDATE_CATALOG_FEED_SCHEDULE_STATUS", "write"], ["TIKTOK_ADS_CREATE_PIXEL", "write"],
  ]);
});

test("Jarvis: comment replies, moderation, bans and messages are outward; deletes destructive", () => {
  expect("youtube", [["YOUTUBE_SET_COMMENT_MODERATION_STATUS", "outward"], ["YOUTUBE_CREATE_COMMENT_REPLY", "outward"], ["YOUTUBE_MARK_COMMENT_AS_SPAM", "outward"], ["YOUTUBE_DELETE_COMMENT", "destructive"]]);
  expect("instagram", [["INSTAGRAM_REPLY_TO_COMMENT", "outward"], ["INSTAGRAM_POST_IG_COMMENT_REPLIES", "outward"], ["INSTAGRAM_DELETE_COMMENT", "destructive"]]);
  expect("facebook", [["FACEBOOK_CREATE_COMMENT", "outward"], ["FACEBOOK_SEND_MESSAGE", "outward"], ["FACEBOOK_DELETE_COMMENT", "destructive"]]);
  expect("whatsapp", [["WHATSAPP_BLOCK_USERS", "outward"], ["WHATSAPP_SEND_TEMPLATE_MESSAGE", "outward"], ["WHATSAPP_CREATE_MAX_PRICE_AGREEMENTS", "money"], ["WHATSAPP_DEREGISTER_PHONE", "destructive"]]);
  expect("highlevel", [["HIGHLEVEL_SEND_MESSAGE", "outward"], ["HIGHLEVEL_ADD_CONTACT_TAGS", "outward"], ["HIGHLEVEL_CREATE_CONTACT", "outward"], ["HIGHLEVEL_CREATE_OPPORTUNITY", "write"], ["HIGHLEVEL_REMOVE_CONTACT_TAGS", "destructive"]]);
});

test("Jarvis: monitoring reads stay reads although their slug holds POST, SEND, BATCH or a write verb", () => {
  expect("facebook", [["FACEBOOK_GET_POST", "read"], ["FACEBOOK_GET_POST_INSIGHTS", "read"], ["FACEBOOK_GET_POST_REACTIONS", "read"], ["FACEBOOK_GET_COMMENTS", "read"]]);
  expect("instagram", [["INSTAGRAM_GET_POST_COMMENTS", "read"], ["INSTAGRAM_GET_POST_INSIGHTS", "read"], ["INSTAGRAM_GET_IG_MEDIA_COMMENTS", "read"]]);
  expect("youtube", [["YOUTUBE_LOAD_CAPTIONS", "read"], ["YOUTUBE_GET_VIDEO_DETAILS_BATCH", "read"], ["YOUTUBE_LIST_COMMENT_THREADS2", "read"]]);
  expect("tiktok", [["TIKTOK_FETCH_PUBLISH_STATUS", "read"]]);
  expect("whatsapp", [["WHATSAPP_WHO_AM_I", "read"], ["WHATSAPP_GET_MESSAGE_HISTORY", "read"]]);
  expect("highlevel", [["HIGHLEVEL_SEARCH_DUPLICATE_CONTACT", "read"]]);
  expect("googlesheets", [["GOOGLESHEETS_BATCH_GET", "read"], ["GOOGLESHEETS_GET_BATCH_VALUES", "read"], ["GOOGLESHEETS_AGGREGATE_COLUMN_DATA", "read"], ["GOOGLESHEETS_VALUES_GET", "read"]]);
  expect("wordpress_com", [["WORDPRESS_COM_GET_POST", "read"], ["WORDPRESS_COM_LIST_SITE_POSTS", "read"]]);
});

test("Jarvis: sheet value clears and SQL are destructive; WordPress.com drafts are writes", () => {
  expect("googlesheets", [["GOOGLESHEETS_CLEAR_VALUES", "destructive"], ["GOOGLESHEETS_EXECUTE_SQL", "destructive"], ["GOOGLESHEETS_VALUES_UPDATE", "write"], ["GOOGLESHEETS_CLEAR_BASIC_FILTER", "write"]]);
  expect("wordpress_com", [["WORDPRESS_COM_CREATE_DRAFT_POST", "write"], ["WORDPRESS_COM_UPDATE_DRAFT_POST", "write"], ["WORDPRESS_COM_DELETE_DRAFT_POST", "destructive"]]);
});

test("Jarvis: a money name stays money whatever a policy says; a slug no policy names fails closed", () => {
  expect("youtube", [["YOUTUBE_SUBSCRIBE_CHANNEL", "money"]]);
  expect("highlevel", [["HIGHLEVEL_LIST_PAYMENTS_COUPON", "money"]]);
  // An unknown future verb: no pattern names it, so name inference (write + outward) decides.
  expect("metaads", [["METAADS_FROBNICATE_THING", "outward"]]);
});

test("policy money list is optional and validated", () => {
  const base = { schema: 1, toolkit: "x", version: "1", destructive: [], outward: [], writes: [], reads: [] };
  assert.equal(parsePolicy(base).money, undefined);
  assert.deepEqual(parsePolicy({ ...base, money: ["X_BUY_*"] }).money, ["X_BUY_*"]);
  assert.throws(() => parsePolicy({ ...base, money: [""] }), /policy_invalid: money/u);
  assert.throws(() => parsePolicy({ ...base, money: "X_*" }), /policy_invalid: money/u);
  assert.equal(classifyComposioTool("X_BOOST_ITEM", parsePolicy({ ...base, money: ["X_BOOST_*"], writes: ["X_*"] })).effect, "money");
  assert.equal(classifyComposioTool("X_GET_BOOST", parsePolicy({ ...base, money: ["X_*BOOST*"] })).effect, "read", "a read-led name stays read");
});
