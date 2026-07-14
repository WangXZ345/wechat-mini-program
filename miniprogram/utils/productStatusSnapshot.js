function buildStatusSnapshot(product = {}) {
  const id = typeof product._id === "string" ? product._id.trim() : "";
  if (!id) return null;
  const isActive = product.isActive === undefined ? true : product.isActive;
  const rawVersion = product.version !== undefined ? product.version : product.dataVersion;
  const version = rawVersion === undefined || rawVersion === null || rawVersion === "" ? 0 : rawVersion;
  if (typeof isActive !== "boolean"
    || typeof version !== "number"
    || !Number.isSafeInteger(version)
    || version < 0) {
    return null;
  }
  return { id, expectedIsActive: isActive, expectedVersion: version };
}

module.exports = { buildStatusSnapshot };
