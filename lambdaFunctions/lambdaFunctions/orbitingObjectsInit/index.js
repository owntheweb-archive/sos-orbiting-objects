
'use strict';

// see any "!!!" denoting areas of mystery and improvement needed

//////////////
// settings //
//////////////

//currently hard coded as part of rendered animation + motion trail effects (1793 is final frame count at 30fps, 59.7 secs)
let numFrames = 1812;

//how many VMs should be launched to handle animation rendering (CAUTION: COSTS INVOLVED)
let numVMs = 1;

//which orbital object datasets to add to the queue
let datasets = ['all','active','altitude'];

let userAgent = 'SOS Dataset Generator (developer@spacefoundation.org)';

// encrypted login info loaded from file
// follow these instructions: http://stackoverflow.com/questions/29372278/aws-lambda-how-to-store-secret-to-external-api
// to generate file:
// cd /local/lambda/function/folder
// aws kms encrypt --key-id the-key-goes-here-from-aws-security-credentials-encrypted-keys --plaintext '{"user":"usernamehere","pass":"passwordhere"}' --query CiphertextBlob --output text | base64 -D > ./encrypted-secret
let tleSecretPath = './encrypted-secret'; //file not included in repository, but generated using aws line above
let tleProtocol = 'https';
let tleServer = 'www.space-track.org';
let tleQueryURI = '/basicspacedata/query/class/tle_latest/ORDINAL/1/EPOCH/%3Enow-30/orderby/NORAD_CAT_ID/format/tle/favorites/Weather';
//let tleQueryURI = '/basicspacedata/query/class/tle_latest/ORDINAL/1/EPOCH/%3Enow-30/orderby/NORAD_CAT_ID/format/tle';
let tleLoginURI = '/ajaxauth/login';
let tleS3Bucket = 'sosorbitingobjects';
let tleS3Key = 'data/tles.txt';

let satcatURL = 'http://celestrak.com/pub/satcat.txt';
let satcatS3Bucket = tleS3Bucket;
let satcatS3Key = 'data/satcat.txt';

let sqsURL = 'https://sqs.us-east-1.amazonaws.com/631764164204/sosGenerateOrbitingObjects';

//////////////
// includes //
//////////////

// Amazon Web Services
var aws = require('aws-sdk');

// request wrapper functions
var request = require('request');

// per space-track.org request, limit request rate to 100kb/s
var BURST_RATE = 1024 * 1024 * 5; // 100KB/sec burst rate
var FILL_RATE = 1024 * 1024 * 5; // 100KB/sec sustained rate
var TokenBucket = require('limiter').TokenBucket;
var bucket = new TokenBucket(BURST_RATE, FILL_RATE, 'second', null);

// load encrypted user/pass file
var fs = require('fs');

// decrypt encrypted user/pass file
var kms = new aws.KMS({region:'us-east-1'}); //match region as needed

// simple queue service (SQS) to store data needed for individual animation frames
var sqs = new aws.SQS({apiVersion: '2012-11-05'});

// place to store large amounts of data as files
var s3 = new aws.S3();

// it flows better with promises
var Promise = require('promise');
aws.config.setPromisesDependency(require('promise')); //aws-sdk now supports promises!

// launch VM army
var ec2 = new aws.EC2({apiVersion: '2015-10-01'});

//////////
// init //
//////////

var encryptedSecret = fs.readFileSync(tleSecretPath);

//////////////////////////////
// handle incoming requests //
//////////////////////////////

exports.handler = function (event, context) {
	try {
		Promise.all([dismissVMArmy(), resetSQS()])
		.then(function(status) { 
			return Promise.all([handleTLETransfer(), handleSATCATTransfer(), clearOldAnimationFrames(), fillSQS()])
		})
		.then(function(status) { 
			return deployVMArmy();
		})
		.then(function(status) {
			console.log('Everything is set! ' + numVMs.toString() + ' VM(s) have been deployed to render dataset animations.');
		})
		.catch(function(error) {
			console.log("exports.handler promise chain failed", error);
			context.fail(error);
		});

	} catch(error) {
		console.log('exports.handler failed', error);
		context.fail("Exception: " + error);
	}
};

//temporary test function
var testRes = function(res) {
	console.log(res);
	return res;
};

// decrypt login info stored separately from this script
var getTLESecret = function() {
	return new Promise(function(resolve, reject) {
		var kmsParams = {
			CiphertextBlob: encryptedSecret
		};
		kms.decrypt(kmsParams, function(error, data) {
			if (error) {
				console.log('getTLESecret failed', error);
				reject(error);
			} else {
				var decryptedString = data.Plaintext.toString('utf8');
				var json = JSON.parse(decryptedString);
				console.log('secret retreived');
				resolve(json);
			}
		});
	});
};	

//get TLE data
var getTLEs = function(secret) {
	return new Promise(function(resolve, reject) {
		var tleQueryURL = tleProtocol + '://' + tleServer + tleQueryURI;
		var tleLoginURL = tleProtocol + '://' + tleServer + tleLoginURI;

		//throttle request rate
		//!!! check and make sure this is actually throttling
		bucket.removeTokens(1, function() {
			request.post({
				'url': tleLoginURL,
				'headers': {
					'User-Agent': userAgent
				},
				'formData': {
					'identity': secret.user,
					'password': secret.pass,
					'query': tleQueryURL
				}
			}, 
			function (error, response, tleData) {
				if (!error && response.statusCode == 200) {
					resolve(tleData);
				} else {
					console.log('getTLEs error', response.statusCode.toString());
					reject(error);
				}
			});
		});
	});
};

var saveTLEs = function(tleData) {
	return new Promise(function(resolve, reject) {
		s3.putObject({
			Bucket: tleS3Bucket,
			Key: tleS3Key,
			Body: tleData,
			ContentType: 'text/plain'
		}, function(error, result) {
			if (error) {
				console.log('saveTLEs failed', error);
				reject(error);
			} else {
				console.log('TLEs saved');
				resolve('TLEs saved');
			}
		});
	});
};

//Move fresh TLE data from source and store on S3
var handleTLETransfer = function() {
	return new Promise(function(resolve, reject) {
		getTLESecret()
		.then(function(secret) {
			return getTLEs(secret);
		})
		.then(function(tleData) {
			return saveTLEs(tleData);
		})
		.then(function(status) {
			resolve(status);
		})
		.catch(function(error) {
			console.log("handleTLETransfer Failed", error);
			reject(error);
		});
	});
};

//get SATCAT data (from another source: it's much faster)
var getSATCAT = function() {
	return new Promise(function(resolve, reject) {
		request({
			'url': satcatURL,
			'headers': {
				'User-Agent': userAgent
			}
		}, 
		function (error, response, satcatData) {
			if (!error && response.statusCode == 200) {
				resolve(satcatData);
			} else {
				console.log('getSATCAT failed', response.statusCode, error);
				reject(error);
			}
		});
	});
};

var saveSATCAT = function(satcatData) {
	return new Promise(function(resolve, reject) {
		s3.putObject({
			Bucket: satcatS3Bucket,
			Key: satcatS3Key,
			Body: satcatData,
			ContentType: 'text/plain'
		}, function(error, result) {
			if (error) {
				console.log('saveSATCAT failed', error);
				reject(error);
			} else {
				console.log('SATCAT saved');
				resolve('SATCAT saved');
			}
		});
	});
};

//Move fresh SATCAT data from source and store on S3
var handleSATCATTransfer = function() {
	return new Promise(function(resolve, reject) {
		getSATCAT()
		.then(function(satcatData) {
			return saveSATCAT(satcatData);
		})
		.then(function(status) {
			resolve(status);
		})
		.catch(function(error) {
			console.log("handleSATCATTransfer Failed", error);
			reject(error);
		});
	});
};

//clear out working frames from the last render to start fresh
var clearOldAnimationFrames = function() {
	return new Promise(function(resolve, reject) {
		console.log('old animation frames cleared');
		resolve('old animation frames cleared');
	});
};

//purge SQS queue to start
var resetSQS = function() {
	return new Promise(function(resolveSQS, rejectSQS) {
		var params = {
			QueueUrl: sqsURL
		};
		
		var sqsPromise = sqs.purgeQueue(params).promise();
		sqsPromise.then(function(data) {
			console.log('resetSQS success');
			resolveSQS('resetSQS success');
		})
		.catch(function(error) {
			console.log('resetSQS failed', error);
			rejectSQS(error);
		});
		
	});
};

//fill the SQS queue with instructions to render each frame (VMs "take a number")
//and add a final instruction to compile the animation
var fillSQS = function() {
	return new Promise(function(resolve, reject) {
		var i, message, entries = [], batches = [], id, batchPromises = [];
		
		datasets.map(function(dataset) {
			for(i=1; i<=numFrames; i++) {
				message = JSON.stringify({
					op: 'render',
					set: dataset,
					frame: i
				});

				id = dataset + i.toString();

				entries.push(prepSQSEntry(message, id));

				//SQS batches hold up to 10 items, keep within that limit
				if(entries.length == 10) {
					batches.push(entries);
					entries = [];
				}
			}
		});

		//add leftover entries to a batch
		batches.push(entries);

		//send message batches in sequence to SQS, first preparing as promises
		batches.map(function(batch){
			batchPromises.push(sendSQSBatch(batch));
		});

		//fulfill the promisses: send all the batch messages in sequence!
		var promise = new Promise.resolve(batchPromises)
		.then(function(allResults) {
			console.log('SQS queue ready');
			resolve('SQS queue ready');
		})
		.catch(function(error) {
			console.log("fillSQS Failed", error);
			reject(error);
		});

	});
};

var prepSQSEntry = function(message, id) {
	return {
		'Id': id,
		'MessageBody': message,
		'DelaySeconds': 0
	}
}

//send up to 10 SQS messages at a time to SQS queue
var sendSQSBatch = function(sqsItems) {
	var params = {
		Entries: sqsItems,
		QueueUrl: sqsURL
	};

	return sqs.sendMessageBatch(params).promise();
};

//halt related VMs (if there any) prior to launching more to handle SQS queue
var dismissVMArmy = function() {
	return new Promise(function(resolve, reject) {
		console.log('VM army dismissed');
		resolve('VM army dismissed');
	});
};

//launch VMs that will process SQS queue items
var deployVMArmy = function() {
	return new Promise(function(resolve, reject) {
		console.log('VM army deployed');
		resolve('VM army deployed');
	});
};
