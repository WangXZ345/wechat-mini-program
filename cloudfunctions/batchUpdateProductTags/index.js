const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const idempotency = require("./idempotency");
const { requirePermission } = require("./auth");
const { createProductTagService } = require("./productTagService");
const { createBatchUpdateProductTagsHandler } = require("./handler");

const productTagService = createProductTagService({ db, idempotency });

exports.main = createBatchUpdateProductTagsHandler({
  requirePermission,
  service: productTagService,
  idempotencyErrorResponse: idempotency.idempotencyErrorResponse
});
