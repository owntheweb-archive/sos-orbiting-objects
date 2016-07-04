
'use strict';

// see any "!!!" denoting areas of mystery and improvement needed

//////////////
// settings //
//////////////

let s3Bucket = 'sosorbitingobjects';

let sqsURL = 'https://sqs.us-east-1.amazonaws.com/631764164204/sosGenerateOrbitingObjects';
//let sqsURL = 'https://sqs.us-east-1.amazonaws.com/YOURARNNUMBER/sosGenerateOrbitingObjects';

var sqsVisibilityTimeout = 15; //number of seconds to hide received/reserved messages from other requests

//////////////
// includes //
//////////////

// Amazon Web Services
var aws = require('aws-sdk');

// load encrypted user/pass file
var fs = require('fs');

// simple queue service (SQS) to store data needed for individual animation frames
var sqs = new aws.SQS({apiVersion: '2012-11-05'});

// it flows better with promises
var Promise = require('promise');
aws.config.setPromisesDependency(require('promise')); //aws-sdk now supports promises!

//place to put files in the cloud
var s3 = new aws.S3({apiVersion: '2015-10-01'});

//send notifications to SNS topic subscribers when everything is complete
var sns = new aws.SNS({apiVersion: '2015-10-01'});

// run shell commands to initiate Blender renderings and to shutdown the system when finished
var shell = require('shelljs');

////////
// go //
////////

// go forth!
var go = function() {
	try {
		getQueueMessage()
		.then(function(message) {
			if(message.continue == true) {
				return processMessage(message);
			} else {
				return passThrough(message);
			}
		})
		.then(function(message) {
			if(message.continue == true) {
				return deleteQueueMessage(message);
			} else {
				return passThrough(message);
			}
		})
		.then(function(message) {
			if(message.continue == true) {
				console.log('queue item processed, time to go again');
				go();
			} else {
				//time to shutdown
				//(let the parent shell script/UserData that is running as super user do that)
				console.log('goodbye...');
			}
		})
		.catch(function(error) {
			console.log('go chain failed', error);
		});
	} catch(error) {
		console.log('go failed', error);
	}
};

//a test function
var processMessage = function(message) {
	console.log('processing message', message);
	return new Promise(function(resolve, reject) {
		if(message.contents.op == 'render') {
			//render one frame of one dataset
			//here we go...
			//soon
			resolve(message);

		} else if(message.contents.op == 'compile') {
			//download all frames, render final animations, build and transfer datasets
			//!!! this isn't being added to the queue yet via the init Lambda function, need to add
			resolve(message);
		}
	});
}

// 
var passThrough = function(toPassThrough) {
	return new Promise(function(resolve, reject) {
		resolve(toPassThrough);
	});
}

//get a message from the queue to process
var getQueueRetries = 0; 
var getQueueMessage = function() {
	console.log('getting queue message');

	var activeMessage = {
		continue: true, // added to determine next actions
		id: '',
		receiptHandle: '', // used to delete messages
		contents: {}
	};

	return new Promise(function(resolve, reject) {
		var params = {
			QueueUrl: sqsURL,
			MaxNumberOfMessages: 1,
			WaitTimeSeconds: 1,
			VisibilityTimeout: sqsVisibilityTimeout
		};

		sqs.receiveMessage(params, function(error, message) {
			if(error) {
				console.log('getQueueMessage failed', error);
				reject(error);
			} else {
				//getQueueRetries
				if(message.hasOwnProperty('Messages')) {
					activeMessage.id = message.Messages[0].MessageId;
					activeMessage.receiptHandle = message.Messages[0].ReceiptHandle;
					activeMessage.contents = JSON.parse(message.Messages[0].Body);
					resolve(activeMessage);
				} else {
					//no message received, try a couple more times before giving up and shutting down
					//aws docs mention a chance that this could happen
					console.log('no messages!');
					getQueueRetries++;
					if(getQueueRetries <= 3) {
						console.log('retry ' + getQueueRetries + ' of 3...')
						resolve(getQueueMessage());
					} else {
						//time to give up, assume queue is empty
						console.log('time to give up...');
						activeMessage.continue = false;
						resolve(activeMessage);
					}
				}
			}
		});
	});
};

// check an item off the list of items to process
var deleteQueueMessage = function(message) {
	console.log('deleting queue message');

	return new Promise(function(resolve, reject) {
		var params = {
			QueueUrl: sqsURL,
			ReceiptHandle: message.receiptHandle
		};

		sqs.deleteMessage(params, function(error, deleteMessage) {
			if(error) {
				console.log('deleteQueueMessage failed', error);
				reject(error);
			} else {
				resolve(message); //returning original message to act upon
			}
		});
	});
};

// go!
go();


