function buildUserCounterId(userId, counterName, profileId = null) {
  if (profileId) {
    return `${String(userId)}:${String(profileId)}:${counterName}`;
  }
  return `${String(userId)}:${counterName}`;
}

module.exports = { buildUserCounterId };
