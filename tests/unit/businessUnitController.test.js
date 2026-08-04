const mongoose = require('mongoose');
const BusinessUnit = require('../../models/BusinessUnit');

describe('Business Unit Model & Soft Delete Plugin', () => {
  it('correctly attaches isDeleted, deletedAt, name, and code fields', () => {
    const paths = BusinessUnit.schema.paths;
    expect(paths.isDeleted).toBeDefined();
    expect(paths.deletedAt).toBeDefined();
    expect(paths.name).toBeDefined();
    expect(paths.code).toBeDefined();
    expect(paths.user).toBeDefined();
  });

  it('configures user-scoped unique compound indexes for name and code', () => {
    const indexes = BusinessUnit.schema.indexes();
    const hasNameIndex = indexes.some(idx => idx[0].user === 1 && idx[0].name === 1 && idx[1].unique);
    const hasCodeIndex = indexes.some(idx => idx[0].user === 1 && idx[0].code === 1 && idx[1].unique);

    expect(hasNameIndex).toBe(true);
    expect(hasCodeIndex).toBe(true);
  });
});
