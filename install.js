/*
 * flex
 * https://github.com/JamesMGreene/node-flex
 *
 * Copyright (c) 2013 James M. Greene
 * Licensed under the MIT license.
 */

/*
 * This simply downloads the requested version of the Adobe Flex SDK.
 */

'use strict';

var os = require('os');
var fs = require('fs');
var path = require('path');
fs.existsSync = fs.existsSync || path.existsSync;
var url = require('url');
var http = require('http');
var cp = require('child_process');
var rimrafAsync = require('rimraf')
var rimraf = rimrafAsync.sync;
var mkdirp = require('mkdirp').sync;
var AdmZip = require('adm-zip');
var D2UConverter = require('dos2unix').dos2unix;
var copyR = require('ncp').ncp;
var pkgMeta = require('./package.json');

// IMPORTANT:
// This `require` call MUST be done post-download because the export of this 
// module is dynamically created based on the executables present after
// downloading and unzipping the relevant Flex SDK.
// If the `require` call is done prior to the download completing, then the
// module's `refresh` function must be invoked afterward to establish the
// correct list of available binaries.
var flexSdk = require('./lib/flex');


var libPath = path.join(__dirname, 'lib', 'flex_sdk');
var tmpDir = (typeof os.tmpdir === 'function') ? os.tmpdir() : os.tmpDir();
var tmpPath = path.join(tmpDir, 'flex_sdk');
var tmpDownloadsPath = path.join(tmpPath, 'downloads');
var tmpExtractionsPath = path.join(tmpPath, 'extractions');

var downloadUrl = pkgMeta.flexSdk.url;
var fileName = downloadUrl.split('/').pop();
var downloadedFile = path.join(tmpDownloadsPath, fileName);

function getOptions() {
  var downloadUrlParts = url.parse(downloadUrl);
  if (process.env.http_proxy) {
    var options = url.parse(process.env.http_proxy, false, true);
    options.path = downloadUrl;
    options.headers = { Host: downloadUrlParts.host };
    return options;
  }
  return downloadUrlParts;
}

function fixLineEndings(err) {
  if (err) {
    console.error('Error extracting archive:\n' + err);
    process.exit(1);
  }

  // Convert all DOS line endings (CrLf) to UNIX line endings (Lf)
  var globOptions = {
    glob: {
      cwd: tmpExtractionsPath
    }
  };
  var conversionEndedAlready = false;
  var errors = [];
  var dos2unix = new D2UConverter(globOptions)
    .on('convert.error', function(err) {
      err.type = 'convert.error';
      errors.push(err);
    })
    .on('processing.error', function(err) {
      err.type = 'processing.error';
      errors.push(err);
    })
    .on('error', function(err) {
      console.error('Critical error while fixing line endings:\n' + (err.stack || err));
      if (!conversionEndedAlready) {
        if (errors.length) {
          fs.writeFileSync(path.join(__dirname, 'install.log'), JSON.stringify(errors, null, "  "));
          console.error('There were errors during the dos2unix process. Check "install.log" for more details!');
        }
        console.error('Exiting prematurely...');
        process.exit(1);
      }
    })
    .on('end', function(stats) {
      conversionEndedAlready = true;
      if (errors.length) {
        fs.writeFileSync(path.join(__dirname, 'install.log'), JSON.stringify(errors, null, "  "));
        console.error('There were errors during the dos2unix process. Check "install.log" for more details!');
      }
      finishIt(stats);
    });
  dos2unix.process(['**/*']);
}

function finishIt(stats) {
  console.log('dos2unix conversion stats: ' + JSON.stringify(stats));

  rimraf(libPath);
  mkdirp(libPath);

  // Move the contents, if there are files left
  copyR(tmpExtractionsPath, libPath, function(err) {
    // For isolating extraction problems
    if (err) {
      console.error('Temporary files not copied to their final destination!\nError: ' + err);
      process.exit(1);
      return;
    }
    
    // Verify that files exist in `libPath` now
    fs.readdir(libPath, function(err, files) {
      if (err) {
        console.error('Cannot verify that temporary files were copied to their final destination!\nError: ' + err);
        process.exit(1);
        return;
      }
      if (!files.length) {
        console.error('Temporary files were not copied to their final destination!');
        process.exit(1);
        return;
      }
    
      // Start utilizing the API by refreshing its binary cache
      flexSdk.refresh();

      // Ensure that the binaries are user-executable (problems with unzip library)
      if (process.platform !== 'win32') {
        Object.keys(flexSdk.bin).forEach(function(binKey) {
          var binaryPath = flexSdk.bin[binKey];
          var stat = fs.statSync(binaryPath);
          // 64 === 0100 (no octal literal in strict mode)
          if (!(stat.mode & 64)) {
            console.log('Fixing file permissions for: ' + binaryPath);
            fs.chmodSync(binaryPath, '755');
          }
        });
      }

      // Declare victory!
      console.log('SUCCESS! The Flex SDK binaries are available at:\n  ' + flexSdk.binDir);

      rimrafAsync(tmpExtractionsPath, function(err) {
        if (err) {
          console.log('\nWARNING: Could not delete the temporary directory but that is OK.\n' +
            'The next `npm install flex-sdk` should take care of that!\n' +
            'Root cause: ' + err);
        }
      });
    });
  });
}

function extractIt() {
  console.log('Extracting contents from the ZIP...');

  rimraf(tmpExtractionsPath);
  mkdirp(tmpExtractionsPath);

  var err;
  try {
    var zip = new AdmZip(downloadedFile);
    zip.extractAllTo(tmpExtractionsPath, true);
  
    // Delete the ZIP file - Don't do this anymore as we preferred to leverage existing downloaded copies!
    //fs.unlinkSync(downloadedFile);
  }
  catch (e) {
    err = e;
  }

  fixLineEndings(err);
}

function fetchIt() {
  // Check if we already have the right ZIP and if it's the correct size
  if (fs.existsSync(downloadedFile)) {
    console.log('It appears that the desired ZIP file is already downloaded. Verifying file size...');
    var localFileSize = parseInt(fs.statSync(downloadedFile).size, 10);
    var opts = getOptions();
    opts.method = 'HEAD';
    var req = http.request(opts, function(res) {
      // This might not work if the remote content is served GZIP-ed
      var remoteFileSize = parseInt(res.headers['content-length'] || -1, 10);
      if (localFileSize === remoteFileSize) {
        console.log('Woohoo, the local file size matched the remote file size (both: ' + localFileSize + ')! Skipping download.');
        extractIt();
      }
      else {
        console.log('Darn, the local file size (' + localFileSize + ') did not match the remote file size (' + remoteFileSize + '). Proceeding to download...');
        downloadIt();
      }
    });
    req.end();
  }
  else {
    downloadIt();
  }
}

function downloadIt() {
  var notifiedCount = 0;
  var count = 0;

  // Do NOT:
  //rimraf(tmpDownloadsPath);

  mkdirp(tmpDownloadsPath);

  var outFile = fs.openSync(downloadedFile, 'w');

  function onData(data) {
    fs.writeSync(outFile, data, 0, data.length, null);
    count += data.length;
    if ((count - notifiedCount) > 800000) {
      console.log('Received ' + Math.floor(count / 1024) + 'KB...');
      notifiedCount = count;
    }
  }

  function onEnd() {
    console.log('Received ' + Math.floor(count / 1024) + 'KB total!');
    fs.closeSync(outFile);
    extractIt();
  }

  function onResponse(response) {
    var status = response.statusCode;
    console.log('Receiving...');

    if (status === 200) {
      response.on('data', onData);
      response.on('end', onEnd);
    }
    else {
      console.log('Error with HTTP request:\n' + JSON.stringify(response.headers));
      client.abort();
      process.exit(1);
    }
  }

  var client = http.get(getOptions(), onResponse);
  console.log('Requesting ' + downloadUrl);
}

fetchIt();
