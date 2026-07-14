const cloud = require("wx-server-sdk");
const { maskPhone } = require("./common/phone");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const { addressSnapshot, maskedAddressSnapshot } = require("./common/address");
const { runIdempotentAction } = require("./common/idempotency");

function ok(data) {
  return { ok: true, data };
}

function fail(message, code) {
  return { ok: false, code, message };
}

function orderNo() {
  const d = new Date();
  const stamp = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
    String(d.getHours()).padStart(2, "0"),
    String(d.getMinutes()).padStart(2, "0"),
    String(d.getSeconds()).padStart(2, "0")
  ].join("");
  return `PO${stamp}${Math.floor(Math.random() * 9000 + 1000)}`;
}

function normalizeDeliveryType(value, shippingType) {
  if (shippingType === "pickup") return "self_pickup";
  if (shippingType === "delivery") return "shipping";
  if (value === "self_pickup" || value === "shipping") return value;
  throw new Error("请选择配送方式");
}

function cleanText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function keyTail(value) {
  return cleanText(value, 160).slice(-6);
}

function logIdempotency(stage, details = {}) {
  console.info("[createOrder:idempotency]", {
    stage,
    actionType: "submit_order",
    keyTail: keyTail(details.idempotencyKey),
    requestHash: details.requestHash || "",
    status: details.status || "",
    orderId: details.orderId || "",
    errorCode: details.errorCode || ""
  });
}

function normalizePhone(phone) {
  const value = cleanText(phone, 30);
  if (!/^1\d{10}$/.test(value) && !/^\+?\d[\d -]{5,28}$/.test(value)) {
    throw new Error("手机号格式错误");
  }
  return value;
}

function normalizeShippingAddress(input = {}) {
  const address = {
    receiverName: cleanText(input.receiverName, 50),
    receiverPhone: normalizePhone(input.receiverPhone),
    province: cleanText(input.province, 40),
    city: cleanText(input.city, 40),
    district: cleanText(input.district, 40),
    detailAddress: cleanText(input.detailAddress, 200),
    remark: cleanText(input.remark, 200)
  };
  if (!address.receiverName) throw new Error("请填写收货人姓名");
  if (!address.detailAddress) throw new Error("请填写详细地址");
  const regionText = cleanText(input.fullAddress, 300) || [
    address.province,
    address.city,
    address.district
  ].filter(Boolean).join("");
  address.fullAddress = regionText && address.detailAddress && regionText.includes(address.detailAddress)
    ? regionText
    : [regionText, address.detailAddress].filter(Boolean).join("");
  return address;
}

async function getPickupSnapshot() {
  const res = await db.collection("settings").doc("pickup_settings").get().catch(() => null);
  const settings = res && res.data ? res.data : null;
  if (!settings || !settings.pickupLocation || !settings.pickupContact || !settings.pickupPhone) {
    throw new Error("自提配置不存在，请联系商家");
  }
  return {
    pickupLocation: settings.pickupLocation || "",
    pickupTimeNote: settings.pickupTimeNote || "",
    pickupContact: settings.pickupContact || "",
    pickupPhone: settings.pickupPhone || "",
    pickupRemark: settings.pickupRemark || ""
  };
}

async function getShippingAddressSnapshot(addressId, openid) {
  const id = cleanText(addressId, 80);
  if (!id) throw new Error("请选择收货地址");
  const res = await db.collection("customer_addresses").doc(id).get();
  const address = res.data;
  if (!address || address.openid !== openid || address.status !== "active") {
    throw new Error("收货地址不存在或已失效");
  }
  return {
    addressId: id,
    shippingAddressSnapshot: addressSnapshot(address),
    shippingAddressMasked: maskedAddressSnapshot(address),
    addressSelectedAt: db.serverDate()
  };
}

async function buildDeliverySnapshot(event, openid) {
  const deliveryType = normalizeDeliveryType(event.deliveryType, event.shippingType);
  if (deliveryType === "self_pickup") {
    return {
      deliveryType,
      shippingType: "pickup",
      addressId: "",
      shippingAddressSnapshot: null,
      shippingAddressMasked: null,
      addressSelectedAt: null,
      pickupInfo: await getPickupSnapshot(),
      shippingAddress: null
    };
  }
  const address = await getShippingAddressSnapshot(event.addressId, openid);
  return {
    deliveryType,
    shippingType: "delivery",
    ...address,
    pickupInfo: null,
    shippingAddress: address.shippingAddressSnapshot
  };
}

async function updateUserDeliveryPreference(user, delivery) {
  const data = {
    defaultDeliveryType: delivery.deliveryType,
    updatedAt: db.serverDate()
  };
  if (delivery.deliveryType === "shipping") {
    data.lastAddressId = delivery.addressId;
  }
  await db.collection("users").doc(user._id).update({ data });
}

async function getUser(openid) {
  const now = db.serverDate();
  const res = await db.collection("users").where({ openid }).limit(1).get();
  if (res.data[0]) return res.data[0];

  const created = await db.collection("users").add({
    data: { openid, nickname: "", phone: "", createdAt: now, updatedAt: now }
  });
  return { _id: created._id, openid };
}

async function getSystemSettings() {
  const res = await db.collection("settings").doc("system_settings").get().catch(() => null);
  const settings = res && res.data ? res.data : {};
  return {
    requirePhoneBeforeOrder: settings.requirePhoneBeforeOrder !== false,
    requireVerifiedPhoneBeforeOrder: settings.requireVerifiedPhoneBeforeOrder === true
  };
}

function codedError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function assertOrderPhoneReady(user) {
  const settings = await getSystemSettings();
  const phoneNumber = user.phoneNumber || user.phone || "";
  const phoneMasked = user.phoneMasked || maskPhone(phoneNumber);
  if (settings.requirePhoneBeforeOrder && !phoneMasked) {
    throw codedError("为了方便商家确认订单和账款，请先绑定手机号。", "PHONE_REQUIRED");
  }
  if (settings.requireVerifiedPhoneBeforeOrder && !user.phoneVerified) {
    throw codedError("请先完成手机号验证后再提交订单。", "PHONE_VERIFY_REQUIRED");
  }
}

function phoneSnapshot(user, now) {
  const phoneNumber = user.phoneNumber || user.phone || "";
  return {
    customerPhoneMasked: user.phoneMasked || maskPhone(phoneNumber),
    customerPhoneSnapshot: phoneNumber,
    customerPhoneVerifiedAt: user.phoneVerified ? (user.phoneUpdatedAt || user.phoneBoundAt || now) : null,
    customerPhoneBindMethod: user.phoneBindMethod || ""
  };
}

async function findOrderByQuery(query) {
  const res = await db.collection("orders")
    .where(query)
    .limit(1)
    .get()
    .catch(() => ({ data: [] }));
  return (res.data || [])[0] || null;
}

async function recoverSubmittedOrder(options = {}) {
  const key = cleanText(options.idempotencyKey, 160);
  const openid = cleanText(options.openid, 120);
  const actionType = cleanText(options.actionType, 80);
  const requestHash = cleanText(options.requestHash, 128);
  if (!openid || !actionType || (!key && !requestHash)) return null;

  const queries = [];
  if (key) {
    queries.push({ userOpenid: openid, idempotencyActionType: actionType, idempotencyKey: key });
    queries.push({ userOpenid: openid, idempotencyActionType: actionType, submitIdempotencyKey: key });
  }
  if (requestHash) {
    queries.push({ userOpenid: openid, idempotencyActionType: actionType, idempotencyRequestHash: requestHash });
    queries.push({ userOpenid: openid, idempotencyActionType: actionType, requestHash });
    queries.push({ userOpenid: openid, orderSource: "product_detail", requestHash });
  }

  let order = null;
  for (const query of queries) {
    order = await findOrderByQuery(query);
    if (order) break;
  }
  if (!order) return null;
  logIdempotency("recover_order", {
    idempotencyKey: key,
    requestHash,
    status: order.status || "",
    orderId: order._id
  });
  return {
    orderId: order._id,
    orderNo: order.orderNo || "",
    status: order.status || "",
    orderStatus: order.status || "",
    createdAt: order.createdAt || null,
    message: "订单已提交，请勿重复提交"
  };
}

async function getRiskLevel(user) {
  const filters = [];
  if (user._id) filters.push({ userId: user._id });
  if (user.openid) filters.push({ userOpenid: user.openid });
  for (const where of filters) {
    const res = await db.collection("customer_accounts").where(where).limit(1).get();
    if (res.data[0] && res.data[0].riskLevel) return normalizeRiskLevel(res.data[0].riskLevel);
  }
  return normalizeRiskLevel(user.riskLevel || "normal");
}

function normalizeRiskLevel(value) {
  if (value === "watch") return "important";
  if (value === "risky") return "risk";
  return value || "normal";
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const productId = event.productId;
  const quantity = Number(event.quantity);

  if (!productId) return fail("缺少商品 ID");
  if (!Number.isInteger(quantity) || quantity <= 0) return fail("下单数量必须是正整数");

  try {
    return await runIdempotentAction({
      db,
      actionType: "submit_order",
      idempotencyKey: event.idempotencyKey,
      operatorIdentity: openid,
      operatorType: "user",
      scope: "user",
      scopeId: openid,
      openid,
      processingTimeoutSeconds: 2 * 60,
      payload: {
        productId,
        quantity,
        shippingType: event.shippingType,
        deliveryType: event.deliveryType,
        addressId: event.addressId || "",
        openid,
        source: "product_detail"
      },
      recoverProcessingResult: (_record, beginResult) => recoverSubmittedOrder({
        idempotencyKey: event.idempotencyKey,
        openid,
        actionType: "submit_order",
        requestHash: beginResult && (beginResult.requestHash || beginResult.record && beginResult.record.requestHash)
      })
    }, async (beginResult) => {
    const requestHash = beginResult && beginResult.requestHash || "";
    const productRes = await db.collection("products").doc(productId).get();
    const product = productRes.data;
    if (!product || product.isActive === false) throw new Error("商品不存在或已下架");

    const user = await getUser(openid);
    await assertOrderPhoneReady(user);
    const riskLevel = await getRiskLevel(user);
    if (riskLevel === "blocked") throw new Error("当前账号暂无法下单，请联系商家。");
    const delivery = await buildDeliverySnapshot(event, openid);

    const unitPrice = Number(product.price || product.priceCents || 0);
    if (!Number.isInteger(unitPrice) || unitPrice < 0) throw new Error("商品价格配置无效");

    const canAutoApprove = riskLevel !== "risk" && Number(product.stock || 0) >= quantity;
    const now = db.serverDate();
    const status = canAutoApprove ? "auto_reviewing" : "pending_admin";
    const generatedOrderNo = orderNo();

    const created = await db.collection("orders").add({
      data: {
        orderNo: generatedOrderNo,
        userId: user._id,
        userOpenid: openid,
        productId,
        productName: product.name,
        quantity,
        unitPrice,
        totalAmount: unitPrice * quantity,
        status,
        reviewType: canAutoApprove ? "auto" : "manual",
        riskLevelSnapshot: riskLevel,
        idempotencyKey: event.idempotencyKey || "",
        submitIdempotencyKey: event.idempotencyKey || "",
        idempotencyActionType: "submit_order",
        idempotencyRequestHash: requestHash,
        requestHash,
        orderSource: "product_detail",
        createdFromCart: false,
        ...phoneSnapshot(user, now),
        paymentMethod: "",
        paymentScreenshotUrl: "",
        paymentStatus: "none",
        deliveryType: delivery.deliveryType,
        shippingType: delivery.shippingType,
        addressId: delivery.addressId,
        pickupInfo: delivery.pickupInfo,
        shippingAddress: delivery.shippingAddress,
        shippingAddressSnapshot: delivery.shippingAddressSnapshot,
        shippingAddressMasked: delivery.shippingAddressMasked,
        addressSelectedAt: delivery.addressSelectedAt,
        deliveryStatus: "pending",
        expressCompany: "",
        expressNo: "",
        shippedAt: null,
        pickedUpAt: null,
        completedAt: null,
        deliveryRemark: "",
        deliveryImageUrl: "",
        createdAt: now,
        approvedAt: null,
        paidMarkedAt: null,
        updatedAt: now
      }
    });

    if (!canAutoApprove) {
      await db.collection("admin_notifications").add({
        data: {
          type: "manual_order_review",
          orderId: created._id,
          productId,
          userOpenid: openid,
          isRead: false,
          createdAt: now
        }
      });
    }

    await updateUserDeliveryPreference(user, delivery);

    const result = {
      orderId: created._id,
      orderNo: generatedOrderNo,
      status,
      orderStatus: status,
      createdAt: new Date().toISOString(),
      message: riskLevel === "risk" ? "订单已提交，请等待商家确认" : (canAutoApprove ? "订单已提交，正在审核" : "订单已提交，等待商家审核")
    };
    logIdempotency("created_order", {
      idempotencyKey: event.idempotencyKey,
      requestHash,
      status,
      orderId: created._id
    });
    return result;
    });
  } catch (err) {
    logIdempotency("failed", {
      idempotencyKey: event.idempotencyKey,
      errorCode: err.code || err.errCode || ""
    });
    return fail(err.message || "创建订单失败", err.code);
  }
};
