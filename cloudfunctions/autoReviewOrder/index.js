"use strict";

const cloud = require("wx-server-sdk");
const { createHandler } = require("./handler");
const {
  applyInventoryMutationInTransaction,
  validateInventoryReplay
} = require("./inventoryMutationService");
const approval = require("./orderApprovalService");
const stockAlert = require("./stockAlert");
const {
  ownerKeyFor,
  stableEventId
} = require("./syncEvents");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = createHandler({
  db,
  cloud,
  stockAlert,
  applyInventoryMutationInTransaction,
  validateInventoryReplay,
  approval,
  ownerKeyFor,
  stableEventId,
  syncOwnerPepper: process.env.SYNC_OWNER_PEPPER || ""
});
