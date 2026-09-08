'use strict';

const nativeLibraryPath = process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
if (!nativeLibraryPath) {
  throw new Error('Quizzer SEA must materialize the LanceDB native addon before loading LanceDB');
}

const nativeModule = { exports: {} };
process.dlopen(nativeModule, nativeLibraryPath);
module.exports = nativeModule.exports;
