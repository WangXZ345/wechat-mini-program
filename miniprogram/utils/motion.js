const MAX_STAGGER_ITEMS = 6;

const CLASS_NAMES = Object.freeze({
  pageEnter: "motion-page-enter",
  pageFade: "motion-page-fade",
  fadeIn: "motion-fade-in",
  slideUp: "motion-slide-up",
  scaleIn: "motion-scale-in",
  press: "motion-press",
  cardPress: "motion-card-press"
});

function pageEnter(options = {}) {
  const settings = options || {};
  return settings.containsFixed || settings.fixed
    ? CLASS_NAMES.pageFade
    : CLASS_NAMES.pageEnter;
}

function fadeIn() {
  return CLASS_NAMES.fadeIn;
}

function slideUp() {
  return CLASS_NAMES.slideUp;
}

function scaleIn() {
  return CLASS_NAMES.scaleIn;
}

function normalizeStaggerLimit(limit) {
  const value = Number(limit);
  if (!Number.isFinite(value)) return MAX_STAGGER_ITEMS;
  return Math.min(MAX_STAGGER_ITEMS, Math.max(0, Math.floor(value)));
}

function staggerClass(index, options = {}) {
  const position = Math.floor(Number(index));
  const settings = options || {};
  const limit = normalizeStaggerLimit(settings.limit);
  if (!Number.isFinite(position) || position < 0 || position >= limit) return "";
  return `${CLASS_NAMES.slideUp} motion-stagger-${position}`;
}

function staggerList(source, options = {}) {
  const sourceLength = Array.isArray(source) ? source.length : Number(source);
  if (!Number.isFinite(sourceLength) || sourceLength <= 0) return [];
  const settings = options || {};
  const length = Math.min(Math.floor(sourceLength), normalizeStaggerLimit(settings.limit));
  return Array.from({ length }, (_, index) => staggerClass(index, settings));
}

function pressEffect(type = "button") {
  const isCard = type === "card" || (type && type.card === true);
  return isCard ? CLASS_NAMES.cardPress : CLASS_NAMES.press;
}

module.exports = {
  pageEnter,
  fadeIn,
  slideUp,
  scaleIn,
  staggerClass,
  staggerList,
  pressEffect
};
