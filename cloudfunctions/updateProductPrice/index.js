const cloud = require("wx-server-sdk");
const { requirePermission } = require("./auth");
const idempotency = require("./idempotency");
const { createProductPriceService } = require("./productPriceService");
const { createLegacyHandler } = require("./handler");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const service = createProductPriceService({ db, idempotency });

exports.main = createLegacyHandler({ requirePermission, service });
