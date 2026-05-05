function buildUserCounterId(userId, counterName) {
  return `${String(userId)}:${counterName}`;
}

module.exports = { buildUserCounterId };
