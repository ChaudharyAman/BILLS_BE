'use strict';

/**
 * rateCardTypes.js — Backend canonical enum for RateCardItemSchema.paymentType.
 *
 * Keep in sync with MBF/src/constants/rateCardTypes.js (frontend).
 * Strategies that consume each type:
 *   UNIT      — pieceRateStrategy    (rateCard.find paymentType === 'UNIT')
 *   PROJECT   — projectBasedStrategy (rateCard.find paymentType === 'PROJECT')
 *   MILESTONE — milestoneBasedStrategy (variableTransactions filter paymentType === 'MILESTONE')
 *   DAY       — dailyWageStrategy    (rateCard.find paymentType === 'DAY')
 *   MONTHLY   — retainerStrategy     (rateCard.find paymentType === 'MONTHLY')
 *
 * POSITION, INTERVIEW, HOUR, CUSTOM are legacy values that remain valid for backward
 * compatibility with existing documents, but have no dedicated strategy.
 */

const RATE_CARD_TYPES = {
  UNIT:      'UNIT',
  PROJECT:   'PROJECT',
  MILESTONE: 'MILESTONE',
  DAY:       'DAY',
  MONTHLY:   'MONTHLY',
  // Legacy / backward-compat only:
  POSITION:  'POSITION',
  INTERVIEW: 'INTERVIEW',
  HOUR:      'HOUR',
  CUSTOM:    'CUSTOM',
};

/** Flat array of all accepted paymentType string values (for Mongoose enum). */
const RATE_CARD_TYPE_VALUES = Object.values(RATE_CARD_TYPES);

/**
 * The paymentType value that each compensationType strategy primarily looks for
 * when resolving a rate from the employee's rateCard array.
 */
const STRATEGY_RATE_CARD_TYPE = {
  piece_rate:      RATE_CARD_TYPES.UNIT,
  project_based:   RATE_CARD_TYPES.PROJECT,
  milestone_based: RATE_CARD_TYPES.MILESTONE,
  daily_wage:      RATE_CARD_TYPES.DAY,
  retainer:        RATE_CARD_TYPES.MONTHLY,
};

module.exports = { RATE_CARD_TYPES, RATE_CARD_TYPE_VALUES, STRATEGY_RATE_CARD_TYPE };
