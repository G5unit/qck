#!/usr/bin/env node
"use strict";
/* requires */
var http = require('http');
var url = require('url');
var async = require('async');
var fs = require('fs');
var rand = require('random-js')();
var smalloc = require('smalloc');  //used only to get smalloc.kMaxLength.

/* static objects */
var codeLookup = {
      1: 'Could not start listener',
      3: 'Could not read config file specified',
      4: 'Test specified does not exist in Configuration',
      5: 'No Server side configuration, listener not started.',
      6: 'No listener Ip or Port specified, server side disabled, no listener started.',
      7: 'No configuration file specified',
      8: 'Parsing JSON from configuration file failed',
      100: 'Test result message',
      200: 'Unknown servercheck test result message',
      300: 'Unknown request received'
};
var icindex = {
      file: 'checkFilename',
      nofile: '',
      log: 'checkLogLevel',
      list: 'listTests',
      exit: 'exit'
};
/* Reporting function */
var log = {};
log.level = 1;
function qcklog(code,msg,req,resp) {
   if( (log.level >= 1 && code < 200) || (log.level >= 2 && code < 300) || (log.level == 3 && code < 400) ) {
      if(log.filestream) { log.filestream.write(msg+'\n'); }  else { console.log(msg); }
   }
   if(log.level == 4 && code >= 100 && code < 300) {
      if(req) { 
                if(log.filestream) {
                         log.filestream.write('Request:\n\tURL: '+req.pathanme+'\n\tMethod: '+req.method+'\n\tHeaders: '+req.headers+'\n\tBody: '+req.body); 
                } else {
                    console.log('Request:\n\tURL: ',req.pathanme,'\n\tMethod: ',req.method,'\n\tHeaders: ',req.headers,'\n\tBody: ',req.body); 
                }
      }
      if(resp) { 
                 if(log.filestream) {
                    log.filestream.write('Response:\n\tStatus Code: '+resp.statusCode+'\n\tHeaders: '+resp.headers+'\n\tBody: '+resp.body); 
                 } else {
                    console.log('Response:\n\tStatus Code: ',resp.statusCode,'\n\tHeaders: ',resp.headers,'\n\tBody: ',resp.body); 
                 }
      }
   }
   if(log.level == 5 && code >= 100 && code < 300) {
      if(req) { if(log.filestream) { log.filestream.write('Request:\n'+req);} else { console.log('Request:\n',req); } }
      if(resp) { if(log.filestream) { log.filestream.write('Response:\n'+resp);} else { console.log('Response:\n',resp); } }
   }
};

/* Helper variables for indexing and config */
var testindex = {};
var clientrequestIndex = {};
var serverresponseIndex = {};

/* Global Options with defaults */
var options = {
      "listenerIp":"127.0.0.1",
      "listenerPort":"6589",
      "server":"127.0.0.1",
      "serverPort":"6589",
      "loglevel":"1",
      "outputfile":null,
      "runtests":null
    };

/* Client side run Test */
var runningIndex = {};
function sendFileInBody(sobj,srr) {
        var boundaryKey = Math.random().toString(16); // random string
        srr.write('Content-Type: multipart/form-data; boundary="'+boundaryKey+'"\r\n');        
        srr.write(
            '--' + boundaryKey + '\r\n'
            + 'Content-Type: application/octet-stream\r\n' 
            + 'Content-Disposition: form-data; name="'+sobj.filename+'"; filename="'
            +sobj.filename+'"\r\n'
            + 'Content-Transfer-Encoding: binary\r\n\r\n' 
        );    
        var fsread = fs.createReadStream(sobj.filename, { end: false });
        fsread.on('error',function(e){ console.log('debug -- got file read error: ',e); srr.end('\r\n--' + boundaryKey + '--'); });
        if(!sobj.transrate || !sobj.transfreq) {  
            fsread.on('end', function() {
               srr.end('\r\n--' + boundaryKey + '--');
            })
            .pipe(srr, { end: false });      
        } else {
            var filebuffer = [];
            var timeframe = Math.round(sobj.transfreq);
            var chunksize = Math.round(sobj.transrate * timeframe / 1000);
            if(chunksize > 65536) { chunksize = 65536; }
            var buffsleeptime = 1;
            var buffersize = 30;                             
            var mchunk = new Buffer(0);
            var sendRatedData = function () {
                     if(filebuffer && filebuffer.length > 0) {
                        srr.write(filebuffer.shift());
                     }
            };
            var putInBuffer = function (pchunk) {
                    if(pchunk && pchunk.length >= chunksize) {
                         if(buffersize > filebuffer.length) {
                              filebuffer.push(pchunk.slice(0,chunksize));
                              setTimeout(putInBuffer,buffsleeptime,pchunk.slice(chunksize));
                         } else { buffsleeptime = timeframe*0.8;
                              setTimeout(putInBuffer,buffsleeptime,pchunk);
                         }
                    } else { if(pchunk) {mchunk = pchunk; } else { mchunk = new Buffer(0);} fsread.resume(); }
            };
            var bufferSendTimer = setInterval(sendRatedData,timeframe);
            var waitForClearBuffer = function(callback) {
                  if(filebuffer && filebuffer.length > 0) { setTimeout(waitForClearBuffer,timeframe*2,callback); }
                  else if(mchunk && mchunk.length > 0) { filebuffer.push(mchunk); mchunk = null; setTimeout(waitForClearBuffer,timeframe*1.5,callback); }
                  else {
                     bufferSendTimer.clearInterval;
                     callback(); 
                  }
            };            
            fsread.on('end', function(){
               waitForClearBuffer(function() {
                     srr.end('\r\n--' + boundaryKey + '--');
               });
            }).on('data', function(dchunk) {
                fsread.pause();
                mchunk = Buffer.concat([mchunk,dchunk]);
                putInBuffer(mchunk);
            });            
        }   
}
function runTest(test,callback) {

     /* generate unique qck ID */
     var qckid = 'qck-id-' + rand.integer(123456789,999999999);
     runningIndex[qckid] = { };
     /* generate request */
     var qckreqopt = testindex[test].clientrequest;
     if(!qckreqopt.headers) { qckreqopt.headers = {}; }
     qckreqopt.headers["x-qck-id"] = qckid;
     if(!qckreqopt.hostname) { qckreqopt.hostname = options.server;}
     if(!qckreqopt.port) { qckreqopt.port = options.serverPort;}
     
     qcklog(151,'Test: '+test+' started   '+Date());
     var qckreq = http.request(qckreqopt, function(qckresp) {
            var qckbody = new Buffer(0);
            qckresp.on('data',function(chunk) {
                if(testindex[test].clientcheck && testindex[test].clientcheck.body) {
                    qckbody = Buffer.concat([qckbody,chunk]);
                }
            }).on('end',function() {
               /* Any client checks to run? */
               var logcode = '';
               var logmsg = 'Test: '+test+',';
               if(testindex[test].clientcheck) {
                  qckresp.body = qckbody;
                  var mscount = 0;
                  for (var i in testindex[test].clientcheck) {
                     if(qckresp[i] != testindex[test].clientcheck[i]) { mscount++; }
                  }
                  if(mscount > 0) { logcode = 100; logmsg = logmsg + ' Status: Client check Failed - count: '+mscount+'  '+Date(); }
                  else { logcode = 100; logmsg = logmsg + ' Status: Client check Passed'+Date(); }
               }
               if(runningIndex[qckid] && runningIndex[qckid].serverlogmsg) {
                   logmsg = logmsg + ' ' + runningIndex[qckid].serverlogmsg;
                   if(runningIndex[qckid].serverlogcode > logcode) { logcode = runningIndex[qckid].serverlogcode; }
               }
               if(!testindex[test].clientcheck && !runningIndex[qckid].serverlogmsg) {
                  logcode = 104;
                  logmsg = 'Test: '+test+'  Response to request received (no checks).   '+Date();
               }
               qcklog(logcode,logmsg,qckreq,qckresp);
               delete runningIndex[qckid];
               callback();
            });
     }).on('error', function(err) {
            qcklog(101,'Test: '+test+', Status: Failed to Run, Message: '+err+'   '+Date(),qckreq,null);
            /* remove from index */
            delete runningIndex[qckid];
            callback();
     });  
     /* Upload file as binary data */         
     if(testindex[test].clientrequest.filename) {
        sendFileInBody(testindex[test].clientrequest,qckreq);
     } else if(testindex[test].clientrequest.body) { qckreq.write(testindex[test].clientrequest.body); qckreq.end(); }
     else { qckreq.end(); }
}
/* Listener side */
function serverSideSendHeaders(sobj,sreq,sresp,fcallback) {
    /* Set response headers */
    var sendHeaders = {};
    var statusCode = 200;
    if(sobj.headers) { sendHeaders = sobj.headers; }
    if(sobj.copyHeaders) { 
        for (var i in sobj.copyHeaders) { sendHeaders[i] = sreq.headers[i]; }
    }
    if(sobj.statusCode) { statusCode = sobj.statusCode; }
    sresp.writeHead(statusCode,'',sendHeaders);
    fcallback();
}
function serverSideChecks(sobj,sreq,sresp) {
      if(sobj) {
            var mscount = 0;
            var logmsg = '';
            var logcode = 0;
            for(var i in sobj) {
                  if(sreq[i] != sobj[i]) {  mscount++; }
            }
            if(mscount > 0) { logcode = 101; logmsg =  ', Server check Failed, count: ' + mscount; }
            else { logcode = 100; logmsg = ', Server check Passed  '+Date(); }
            if(sreq.headers["x-qck-id"] && runningIndex[sreq.headers["x-qck-id"]]) {
                   runningIndex[sreq.headers["x-qck-id"]].serverlogmsg = logmsg;
                   runningIndex[sreq.headers["x-qck-id"]].serverlogcode = logcode;
            } else { qcklog(200,'(U) Test: '+serverresponseIndex[sreq.method+'::'+url.parse(sreq.url).path].testname+logmsg,sreq,sresp); }
      }
}
/* register on request */
function onRequest(req,resp) {
    var indexpath = req.method + '::' + url.parse(req.url).path;
    if(serverresponseIndex[indexpath]) { 
        /* If filename then start sending early response */
        if(serverresponseIndex[indexpath].serverresponse.filename) {
              serverSideSendHeaders(serverresponseIndex[indexpath].serverresponse,req,resp,function() {
                 sendFileInBody(serverresponseIndex[indexpath].serverresponse, resp);
              });
        }
        /* Get body */
        var fbody = '';
        req.on('error', function(err) {
           caseLog(serverresponseIndex[pathname]); 
        }).on('data', function(chunk) {
            if( serverresponseIndex[indexpath].serverresponse.copyBody || 
                (serverresponseIndex[indexpath].servercheck && serverresponseIndex[indexpath].servercheck.body) ) {
                  fbody += chunk;
             }
         }).on('end', function() {
            /* Do server side checks */
            serverSideChecks(serverresponseIndex[indexpath].servercheck,req,resp);
            /* If filename is NOT present set response headers, body and send response */
            if(!serverresponseIndex[indexpath].serverresponse.filename) {
               serverSideSendHeaders(serverresponseIndex[indexpath].serverresponse,req,resp,function() {
                  if(serverresponseIndex[indexpath].serverresponse.copyBody && fbody) { resp.write(fbody); }
                  else if(serverresponseIndex[indexpath].serverresponse.body) { resp.write(serverresponseIndex[indexpath].serverresponse.body); }
                  resp.end();            
               });
             }
         });
   }
   else { qcklog(300,'Unknown Request received, method::path is - '+indexpath,req,null); req.connection.end();}
}
/* start listener */
var httplistener = 0;
function initListener(ip,port) {
  httplistener = http.createServer(onRequest).listen(port,ip).on('error',function(err) {
     qcklog(1,'Error from Listener, more info: '+ err);
  });
}
function checkLogLevel(loglevel,callback) {
   if(loglevel) { log.level = loglevel; }
   else { log.level = 1; }
   callback(null,'Logging set to level '+log.level);
}
function checkFilename(file,callback) {
   if(file) {
     var filestream = fs.createWriteStream(file);
     if(filestream) {
       if(log.filestream) { log.filestream.end; }
       log.filestream = filestream; callback(null,1); 
     } else { callback(9,'Could not open file: '+file+': '+err);}
  } else { callback(null,null); }
}
function readConfig(cfgfile,callback) {
   if(cfgfile) {
      fs.readFile(cfgfile, function(err,data) {
         if(err) { callback(3,'Error opening file: '+cfgfile+', Message: '+err); }
         else {
             var parData = {};
             try { parData = JSON.parse(data); }
             catch(e) { callback(8,cfgfile+': '+e); }
             /* set options */
             if(parData["__globalconfig__"]) {
                for(var i in parData["__globalconfig__"]) {
                   if(options.hasOwnProperty(i)) { options[i] = parData["__globalconfig__"][i]; }
                }
              }
             /* set index objects */
             testindex = parData;
             for(var i in testindex) {
                if(testindex[i].clientrequest) { clientrequestIndex.i = testindex.i ; }
             }
             for(var i in testindex) {
                if(testindex[i].serverresponse) { 
                     var hashkey = testindex[i].serverresponse.method + '::' + testindex[i].serverresponse.pathname;
                     serverresponseIndex[hashkey] = testindex[i] ; 
                     serverresponseIndex[hashkey].testname = i ; 
                }
             }
             var qcount = 0;
             for(var j in serverresponseIndex) { qcount++; }
             if(qcount > 0) {
                 /* start listener */
                 if(!options.listenerIp || !options.listenerPort) { 
                     qcklog(6,'No listener IP or Port specified, server side disabled, no listener started.');
                 } else { initListener(options.listenerIp,options.listenerPort); }
             } else { qcklog(5,'No Server side configuration, listener not started.'); }                 
             callback(null,1);
         }
      });
   } else { callback(7,'No configuration file specified. Usage:   qck.js <configuration file>'); }
}
function closeQck() {
   setTimeout(process.exit,1000);
}
function listTests() {
  console.log('Tests available to run:');
  for(var i in testindex) {
     if(testindex[i].clientrequest) { console.log('  ',i); }
  }
  console.log('Listener setup: ');
  for(var i in serverresponseIndex) {
     console.log('  Defined under test: ',serverresponseIndex[i].testname,'\tMethod::Path =  ',i);
  }

}
var testcount = 0;
function testDone(testid) {
   if(testcount <= 1) {
    /* all test complete, wait a few seconds for log messagaes to flush, stop listener, process exit */
    setTimeout(closeQck, 2000);
   } else testcount--;
}
function checkMode(tests,callback) {
   if(tests) { 
         var qckarr = tests.toString().split(",");
         for (var i in qckarr) { 
           if(testindex[qckarr[i]] && testindex[qckarr[i]].clientrequest){ 
              testcount++; runTest(qckarr[i],testDone);
           }
         }
         if(testcount < 1) { callback('No qualified tests to run',null); }
         else { callback(null,null); }
   }
   else {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', function(chunk) {
         if (chunk !== null) {
             var ckstr = chunk.toString();
             var icdata = ckstr.substring(0, ckstr.length-1);
          /* If begins with -- evaluate option */
             var icpattern = new RegExp(/^(\s+)?--([a-z]*)=?(.*)?$/);
             var icmatch = icdata.match(icpattern);
             if(icmatch && icmatch[2] && icindex.hasOwnProperty(icmatch[2]) ) { 
               if(icmatch[2] == 'exit') { process.exit(0); }
               else if(icmatch[2] == 'file' && icmatch[3]) { checkFilename(icmatch[3],qcklog); }
               else if(icmatch[2] == 'nofile' && log.filestream) { log.filestream.end(); delete log.filestream; }
               else if(icmatch[2] == 'log') { if(icmatch[3]) { checkLogLevel(icmatch[3],qcklog); }
                                              else { console.log('Current log level is :'+log.level); } 
                                            }
               else if(icmatch[2] == 'list') { listTests(); }
             }
             else {
                var qckarr = icdata.toString().split(",");
                for (var i in qckarr) {
                  if(testindex[qckarr[i]]) { 
                      if(testindex[qckarr[i]].clientrequest) { runTest(qckarr[i],qcklog); }
                      else {qcklog(105,'Test: '+qckarr[i]+' does not have clientrequest object defined.'); }
                  }
                  else {qcklog(103,'Test: '+qckarr[i]+' is not defined'); }
                }
            }
         }
      });
      callback(null,null);
   }
}
async.series([
    function(callback){
        readConfig(process.argv[2], callback);
    },
    function(callback){
        checkFilename(options.outputfile, callback);
    },
    function(callback){
        checkLogLevel(options.loglevel,callback);
    },
    function(callback){
        checkMode(options.runtests,callback);
    }
],
function(err, results){
    if(err) { console.log(results); closeQck(); }
});
