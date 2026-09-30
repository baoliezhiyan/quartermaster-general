// Compress large snapshots independently; small receipts/presence updates avoid zlib overhead.
export const compressionThreshold=4096;
export const socketCompression={threshold:compressionThreshold,serverNoContextTakeover:true,clientNoContextTakeover:true,concurrencyLimit:4,zlibDeflateOptions:{level:1}};
