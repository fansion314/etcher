// Keep the descriptor lifetime correct even when the device flush fails.
exports.installFlushBeforeClose = (File) => {
  const closeFile = File.prototype._close;
  File.prototype._close = async function () {
    try {
      if (this.oWrite && this.fileHandle) await this.fileHandle.sync();
    } finally {
      await closeFile.call(this);
    }
  };
};
