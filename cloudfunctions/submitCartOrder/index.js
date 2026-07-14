const cloud = require("wx-server-sdk");
const { maskPhone } = require("./common/phone");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const { addressSnapshot, maskedAddressSnapshot } = require("./common/address");
const { runIdempotentAction } = require("./common/idempotency");

function ok(data) {
  return { ok: true, data };
}

function fail(message, code) {
  return { ok: false, code, message };
}

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
  } catch (err) {
    const message = String(err && err.message || err || "");
    if (!/already exists|collection exists|DATABASE_COLLECTION_ALREADY_EXIST|already_exist/i.test(message)) {
      const notSupported = /createCollection is not a function/i.test(message);
      if (notSupported) return;
      throw err;
    }
  }
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

function normalizeIdList(value) {
  const list = Array.isArray(value) ? value : [];
  return Array.from(new Set(list.map((item) => cleanText(item, 80)).filter(Boolean))).sort();
}

function keyTail(value) {
  return cleanText(value, 160).slice(-6);
}

function logIdempotency(stage, details = {}) {
  console.info("[submitCartOrder:idempotency]", {
    stage,
    actionType: "submit_cart_order",
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

async function getPickupSnapshot(tx) {
  const res = await tx.collection("settings").doc("pickup_settings").get().catch(() => null);
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

async function getShippingAddressSnapshot(tx, addressId, openid) {
  const id = cleanText(addressId, 80);
  if (!id) throw new Error("请选择收货地址");
  const res = await tx.collection("customer_addresses").doc(id).get();
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

async function buildDeliverySnapshot(tx, event, openid) {
  const deliveryType = normalizeDeliveryType(event.deliveryType, event.shippingType);
  if (deliveryType === "self_pickup") {
    return {
      deliveryType,
      shippingType: "pickup",
      addressId: "",
      shippingAddressSnapshot: null,
      shippingAddressMasked: null,
      addressSelectedAt: null,
      pickupInfo: await getPickupSnapshot(tx),
      shippingAddress: null
    };
  }
  const address = await getShippingAddressSnapshot(tx, event.addressId, openid);
  return {
    deliveryType,
    shippingType: "delivery",
    ...address,
    pickupInfo: null,
    shippingAddress: address.shippingAddressSnapshot
  };
}

async function updateUserDeliveryPreference(tx, user, delivery) {
  const data = {
    defaultDeliveryType: delivery.deliveryType,
    updatedAt: db.serverDate()
  };
  if (delivery.deliveryType === "shipping") {
    data.lastAddressId = delivery.addressId;
  }
  await tx.collection("users").doc(user._id).update({ data });
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
    queries.push({ userOpenid: openid, orderSource: "cart", requestHash });
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

async function getRiskLevel(tx, user) {
  const filters = [];
  if (user._id) filters.push({ userId: user._id });
  if (user.openid) filters.push({ userOpenid: user.openid });
  for (const where of filters) {
    const res = await tx.collection("customer_accounts").where(where).limit(1).get();
    if (res.data[0] && res.data[0].riskLevel) return normalizeRiskLevel(res.data[0].riskLevel);
  }
  return normalizeRiskLevel(user.riskLevel || "normal");
}

function normalizeRiskLevel(value) {
  if (value === "watch") return "important";
  if (value === "risky") return "risk";
  return value || "normal";
}

exports.main = async (event = {}) => {
  const openid = cloud.getWXContext().OPENID;

  try {
    await ensureCollection("order_items");
    const user = await getUser(openid);
    await assertOrderPhoneReady(user);
    const selectedCartItemIds = normalizeIdList(event.selectedCartItemIds);
    return await runIdempotentAction({
      db,
      actionType: "submit_cart_order",
      idempotencyKey: event.idempotencyKey,
      operatorIdentity: openid,
      operatorType: "user",
      scope: "user",
      scopeId: openid,
      openid,
      userId: user._id,
      processingTimeoutSeconds: 2 * 60,
      payload: {
        selectedCartItemIds,
        shippingType: event.shippingType,
        deliveryType: event.deliveryType,
        addressId: event.addressId || "",
        openid,
        source: "cart"
      },
      recoverProcessingResult: (_record, beginResult) => recoverSubmittedOrder({
        idempotencyKey: event.idempotencyKey,
        openid,
        actionType: "submit_cart_order",
        requestHash: beginResult && (beginResult.requestHash || beginResult.record && beginResult.record.requestHash)
      })
    }, async (beginResult) => {
    const requestHash = beginResult && beginResult.requestHash || "";
    const result = await db.runTransaction(async (tx) => {
      const riskLevel = await getRiskLevel(tx, user);
      if (riskLevel === "blocked") throw new Error("当前账号暂无法下单，请联系商家。");
      const delivery = await buildDeliverySnapshot(tx, event, openid);

      const cartWhere = { userOpenid: openid, selected: true };
      if (selectedCartItemIds.length) cartWhere._id = _.in(selectedCartItemIds);
      const cartRes = await tx.collection("carts")
        .where(cartWhere)
        .limit(100)
        .get();
      const carts = cartRes.data;
      if (!carts.length) throw new Error("请先选择商品");

      const items = [];
      let allEnough = true;
      let totalAmount = 0;

      for (const cart of carts) {
        const quantity = Math.floor(Number(cart.quantity || 0));
        if (!Number.isInteger(quantity) || quantity <= 0) throw new Error("购物车数量无效");

        const product = (await tx.collection("products").doc(cart.productId).get()).data;
        if (!product || product.isActive === false) throw new Error("购物车包含不可用商品");
        const unitPrice = Number(product.price || 0);
        if (!Number.isInteger(unitPrice) || unitPrice <= 0) throw new Error("购物车包含不能下单的商品");

        const stockEnough = Number(product.stock || 0) >= quantity;
        if (!stockEnough) allEnough = false;
        const total = unitPrice * quantity;
        totalAmount += total;
        items.push({
          product,
          cartId: cart._id,
          productId: cart.productId,
          productName: product.name || "",
          productImage: product.imageUrl || "",
          specification: product.specification || "",
          productionDate: product.productionDate || "",
          quantity,
          unitPrice,
          totalAmount: total,
          stockCheckStatus: stockEnough ? "enough" : "insufficient"
        });
      }

      const now = db.serverDate();
      const status = allEnough && riskLevel !== "risk" ? "auto_reviewing" : "pending_admin";
      const first = items[0];
      const generatedOrderNo = orderNo();
      const cartItemIds = items.map((item) => item.cartId).filter(Boolean).sort();
      const created = await tx.collection("orders").add({
        data: {
          orderNo: generatedOrderNo,
          userId: user._id,
          userOpenid: openid,
          orderType: "cart",
          productId: first.productId,
          productName: items.length === 1 ? first.productName : `${first.productName} 等 ${items.length} 件商品`,
          quantity: items.reduce((sum, item) => sum + item.quantity, 0),
          unitPrice: items.length === 1 ? first.unitPrice : 0,
          totalAmount,
          itemCount: items.length,
          status,
          reviewType: status === "auto_reviewing" ? "auto" : "manual",
          riskLevelSnapshot: riskLevel,
          idempotencyKey: event.idempotencyKey || "",
          submitIdempotencyKey: event.idempotencyKey || "",
          idempotencyActionType: "submit_cart_order",
          idempotencyRequestHash: requestHash,
          requestHash,
          cartSubmitHash: requestHash,
          orderSource: "cart",
          cartItemIds,
          selectedCartItemIds: cartItemIds,
          createdFromCart: true,
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

      for (const item of items) {
        await tx.collection("order_items").add({
          data: {
            orderId: created._id,
            productId: item.productId,
            productName: item.productName,
            productImage: item.productImage,
            specification: item.specification,
            productionDate: item.productionDate,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            totalAmount: item.totalAmount,
            stockCheckStatus: item.stockCheckStatus,
            createdAt: now
          }
        });
        await tx.collection("carts").doc(item.cartId).remove();
      }

      if (status === "pending_admin") {
        await tx.collection("admin_notifications").add({
          data: {
            type: "manual_cart_order_review",
            orderId: created._id,
            userOpenid: openid,
            isRead: false,
            createdAt: now
          }
        });
      }

      await updateUserDeliveryPreference(tx, user, delivery);

      return {
        orderId: created._id,
        orderNo: generatedOrderNo,
        status,
        orderStatus: status,
        createdAt: new Date().toISOString(),
        message: riskLevel === "risk" ? "订单已提交，请等待商家确认" : (status === "auto_reviewing" ? "订单已提交，正在审核" : "订单已提交，等待商家审核")
      };
    });

    logIdempotency("created_order", {
      idempotencyKey: event.idempotencyKey,
      requestHash,
      status: result.status || "",
      orderId: result.orderId || ""
    });
    return result;
    });
  } catch (err) {
    logIdempotency("failed", {
      idempotencyKey: event.idempotencyKey,
      errorCode: err.code || err.errCode || ""
    });
    return fail(err.message || "提交购物车订单失败", err.code);
  }
};
