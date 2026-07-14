const cloud = require("wx-server-sdk");
const { requirePermission } = require("./auth");
const stockAlert = require("./stockAlert");
const idempotency = require("./idempotency");
const { createInventoryWarningService } = require("./service");
const { createLegacyHandler } = require("./handler");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const service = createInventoryWarningService({ db, stockAlert, idempotency });

exports.main = createLegacyHandler({ requirePermission, service });
