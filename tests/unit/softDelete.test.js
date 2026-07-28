const mongoose = require('mongoose');
const softDeletePlugin = require('../../middleware/softDeletePlugin');

describe('Soft Delete Plugin & Bulk Deletion Integrity', () => {
  let TestSchema;
  let TestModel;

  beforeAll(() => {
    TestSchema = new mongoose.Schema({
      user: mongoose.Schema.Types.ObjectId,
      employeeId: { type: String, unique: true },
      name: String,
    });
    TestSchema.plugin(softDeletePlugin);
    TestModel = mongoose.model('TestSoftDeleteDoc', TestSchema);
  });

  it('correctly attaches isDeleted and deletedAt schema fields', () => {
    const paths = TestModel.schema.paths;
    expect(paths.isDeleted).toBeDefined();
    expect(paths.deletedAt).toBeDefined();
  });
});
