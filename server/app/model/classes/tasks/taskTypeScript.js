/*
 Copyright [2016] [Relevance Lab]

 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

 http://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
 */

var logger = require('_pr/logger')(module);
var mongoose = require('mongoose');
var extend = require('mongoose-schema-extend');
var instancesDao = require('_pr/model/classes/instance/instance.js');
var scriptService = require('_pr/services/scriptService.js');
var logsDao = require('_pr/model/dao/logsdao.js');
var credentialCryptography = require('_pr/lib/credentialcryptography')
var Chef = require('_pr/lib/chef');
var taskTypeSchema = require('_pr/model/classes/tasks/taskTypeSchema');
var SSHExec = require('_pr/lib/utils/sshexec');
var Schema = mongoose.Schema;
var appConfig = require('_pr/config');
var fileIo = require('_pr/lib/utils/fileio');
var uuid = require('node-uuid');
var instanceLogModel = require('_pr/model/log-trail/instanceLog.js');

var scriptTaskSchema = taskTypeSchema.extend({
    nodeIds: [String],
    scriptTypeName: String,
    scriptDetails: [{
        scriptId: {
            type: String,
            requred: true
        },
        scriptParameters: [String]
    }]
});

scriptTaskSchema.methods.getNodes = function() {
    return this.nodeIds;
};

scriptTaskSchema.methods.execute = function(userName, baseUrl, choiceParam, nexusData, blueprintIds, envId, onExecute, onComplete) {
    var self = this;
    var instanceIds = this.nodeIds;
    var scriptDetails = this.scriptDetails;
    if (!(instanceIds && instanceIds.length)) {
        if (typeof onExecute === 'function') {
            onExecute({
                message: "Empty Instance List"
            }, null);
        }
        return;
    }
    instancesDao.getInstances(instanceIds, function(err, instances) {
        if (err) {
            logger.error(err);
            return;
        }
        for (var i = 0; i < instances.length; i++) {
            (function(instance) {
                var timestampStarted = new Date().getTime();
                var actionLog = instancesDao.insertOrchestrationActionLog(instance._id, null, userName, timestampStarted);
                instance.tempActionLogId = actionLog._id;
                var logsReferenceIds = [instance._id, actionLog._id];
                var instanceLog = {
                    actionId: actionLog._id,
                    instanceId: instance._id,
                    orgName: instance.orgName,
                    bgName: instance.bgName,
                    projectName: instance.projectName,
                    envName: instance.environmentName,
                    status: instance.instanceState,
                    actionStatus: "pending",
                    platformId: instance.platformId,
                    blueprintName: instance.blueprintData.blueprintName,
                    data: instance.runlist,
                    platform: instance.hardware.platform,
                    os: instance.hardware.os,
                    size: instance.instanceType,
                    user: userName,
                    createdOn: new Date().getTime(),
                    startedOn: new Date().getTime(),
                    providerType: instance.providerType,
                    action: "Script-Execution",
                    logs: []
                };
                if (!instance.instanceIP) {
                    var timestampEnded = new Date().getTime();
                    logsDao.insertLog({
                        referenceId: logsReferenceIds,
                        err: true,
                        log: "Instance IP is not defined. Chef Client run failed",
                        timestamp: timestampEnded
                    });
                    instancesDao.updateActionLog(instance._id, actionLog._id, false, timestampEnded);
                    instanceLog.endedOn = new Date().getTime();
                    instanceLog.actionStatus = "failed";
                    instanceLog.logs = {
                        err: true,
                        log: "Instance IP is not defined. Chef Client run failed",
                        timestamp: new Date().getTime()
                    };
                    instanceLogModel.createOrUpdate(actionLog._id, instance._id, instanceLog, function(err, logData) {
                        if (err) {
                            logger.error("Failed to create or update instanceLog: ", err);
                        }
                    });

                    instanceOnCompleteHandler({ message: "Instance IP is not defined. Chef Client run failed" }, 1, instance._id, null, actionLog._id);
                    return;
                }
                credentialCryptography.decryptCredential(instance.credentials, function(err, decryptedCredentials) {
                    var sshOptions = {
                        username: decryptedCredentials.username,
                        host: instance.instanceIP,
                        port: 22
                    }
                    if (decryptedCredentials.pemFileLocation) {
                        sshOptions.privateKey = decryptedCredentials.pemFileLocation;
                    } else {
                        sshOptions.password = decryptedCredentials.password;
                    }
                    for (var j = 0; j < scriptDetails.length; j++) {
                        (function(script) {
                            scriptService.getScriptById(script.scriptId, function(err, scripts) {
                                if (err) {
                                    logger.error(err);
                                    return;
                                } else if (!scripts.file) {
                                    logger.debug("There is no script belong to instance : " + instance.instanceIP);
                                    return;
                                } else {
                                    if (scripts.type === 'Bash') {
                                        executeBashScript(scripts, sshOptions, logsReferenceIds, script.scriptParameters);
                                    } else {
                                        return;
                                    }
                                }
                            })
                        })(scriptDetails[j]);
                    }
                });
            })(instances[i]);
        }
        if (typeof onExecute === 'function') {
            onExecute(null, {
                instances: instances,
            });
        }
    })

    function instanceOnCompleteHandler(err, status, instanceId, executionId, actionId) {
        var overallStatus = 0;
        var instanceResultList = [];
        var result = {
            instanceId: instanceId,
            status: 'success'
        }
        if (actionId) {
            result.actionId = actionId;
        }
        if (executionId) {
            result.executionId = executionId;
        }
        if (err) {
            result.status = 'failed';
            overallStatus = 1;
        } else {
            if (status === 0) {
                result.status = 'success';
            } else {
                result.status = 'failed';
                overallStatus = 1;
            }
        }
        instanceResultList.push(result);
        if (instanceResultList.length === scriptDetails.length) {
            logger.debug('Type of onComplete: ' + typeof onComplete);
            if (typeof onComplete === 'function') {
                onComplete(null, overallStatus, {
                    instances: instanceResultList
                });
            }
        }
    }

    function executeBashScript(script, sshOptions, logsReferenceIds, scriptParameters) {
        var sshExec = new SSHExec(sshOptions);
        var cmdScript = script.file;
        var cmdLine = 'eval ' + cmdScript.toString().trim();
        if (scriptParameters.length > 0) {
            for (var j = 0; j < scriptParameters.length; j++) {
                cmdLine = cmdLine + ' "' + scriptParameters[j] + '"';
            }
        }
        sshExec.exec(cmdLine, function(err, retCode) {
            if (err) {
                var timestampEnded = new Date().getTime();
                logsDao.insertLog({
                    referenceId: logsReferenceIds,
                    err: true,
                    log: 'Unable to run script ' + script.name,
                    timestamp: timestampEnded
                });
                instancesDao.updateActionLog(logsReferenceIds[0], logsReferenceIds[1], false, timestampEnded);
                instanceLog.endedOn = new Date().getTime();
                instanceLog.actionStatus = "failed";
                instanceLog.logs = {
                    err: true,
                    log: "Unable to run script " + script.name,
                    timestamp: new Date().getTime()
                };
                instanceLogModel.createOrUpdate(actionLog._id, instance._id, instanceLog, function(err, logData) {
                    if (err) {
                        logger.error("Failed to create or update instanceLog: ", err);
                    }
                });
                instanceOnCompleteHandler(err, 1, logsReferenceIds[0], null, logsReferenceIds[1]);
                return;
            }
            if (retCode == 0) {
                var timestampEnded = new Date().getTime();
                logsDao.insertLog({
                    referenceId: logsReferenceIds,
                    err: false,
                    log: 'Task execution success for script ' + script.name,
                    timestamp: timestampEnded
                });
                instancesDao.updateActionLog(logsReferenceIds[0], logsReferenceIds[1], true, timestampEnded);
                instanceLog.endedOn = new Date().getTime();
                instanceLog.actionStatus = "success";
                instanceLog.logs = {
                    err: false,
                    log: 'Task execution success for script ' + script.name,
                    timestamp: new Date().getTime()
                };
                instanceLogModel.createOrUpdate(actionLog._id, instance._id, instanceLog, function(err, logData) {
                    if (err) {
                        logger.error("Failed to create or update instanceLog: ", err);
                    }
                });
                instanceOnCompleteHandler(null, 0, logsReferenceIds[0], null, logsReferenceIds[1]);
                return;
            } else {
                instanceOnCompleteHandler(null, retCode, logsReferenceIds[0], null, logsReferenceIds[1]);
                if (retCode === -5000) {
                    logsDao.insertLog({
                        referenceId: logsReferenceIds,
                        err: true,
                        log: 'Host Unreachable',
                        timestamp: new Date().getTime()
                    });
                    instanceLog.endedOn = new Date().getTime();
                    instanceLog.actionStatus = "failed";
                    instanceLog.logs = {
                        err: true,
                        log: 'Host Unreachable',
                        timestamp: new Date().getTime()
                    };
                    instanceLogModel.createOrUpdate(actionLog._id, instance._id, instanceLog, function(err, logData) {
                        if (err) {
                            logger.error("Failed to create or update instanceLog: ", err);
                        }
                    });
                    return;
                } else if (retCode === -5001) {
                    logsDao.insertLog({
                        referenceId: logsReferenceIds,
                        err: true,
                        log: 'Invalid credentials',
                        timestamp: new Date().getTime()
                    });
                    instanceLog.endedOn = new Date().getTime();
                    instanceLog.actionStatus = "failed";
                    instanceLog.logs = {
                        err: true,
                        log: 'Invalid credentials',
                        timestamp: new Date().getTime()
                    };
                    instanceLogModel.createOrUpdate(actionLog._id, instance._id, instanceLog, function(err, logData) {
                        if (err) {
                            logger.error("Failed to create or update instanceLog: ", err);
                        }
                    });
                    return;
                } else {
                    logsDao.insertLog({
                        referenceId: logsReferenceIds,
                        err: true,
                        log: 'Unknown error occured. ret code = ' + retCode,
                        timestamp: new Date().getTime()
                    });
                    instanceLog.endedOn = new Date().getTime();
                    instanceLog.actionStatus = "failed";
                    instanceLog.logs = {
                        err: true,
                        log: 'Unknown error occured. ret code = ' + retCode,
                        timestamp: new Date().getTime()
                    };
                    instanceLogModel.createOrUpdate(actionLog._id, instance._id, instanceLog, function(err, logData) {
                        if (err) {
                            logger.error("Failed to create or update instanceLog: ", err);
                        }
                    });
                    return;
                }
                var timestampEnded = new Date().getTime();
                logsDao.insertLog({
                    referenceId: logsReferenceIds,
                    err: true,
                    log: 'Error in running script ' + script.name,
                    timestamp: timestampEnded
                });
                instancesDao.updateActionLog(logsReferenceIds[0], logsReferenceIds[1], false, timestampEnded);
                instanceLog.endedOn = new Date().getTime();
                instanceLog.actionStatus = "failed";
                instanceLog.logs = {
                    err: true,
                    log: 'Error in running script ' + script.name,
                    timestamp: new Date().getTime()
                };
                instanceLogModel.createOrUpdate(actionLog._id, instance._id, instanceLog, function(err, logData) {
                    if (err) {
                        logger.error("Failed to create or update instanceLog: ", err);
                    }
                });
                return;
            }
        }, function(stdOut) {
            logsDao.insertLog({
                referenceId: logsReferenceIds,
                err: false,
                log: stdOut.toString('ascii'),
                timestamp: new Date().getTime()
            });
            instanceLog.logs = {
                err: false,
                log: stdOut.toString('ascii'),
                timestamp: new Date().getTime()
            };
            instanceLogModel.createOrUpdate(actionLog._id, instance._id, instanceLog, function(err, logData) {
                if (err) {
                    logger.error("Failed to create or update instanceLog: ", err);
                }
            });
        }, function(stdErr) {
            logsDao.insertLog({
                referenceId: logsReferenceIds,
                err: true,
                log: stdErr.toString('ascii'),
                timestamp: new Date().getTime()
            });
            instanceLog.logs = {
                err: true,
                log: stdErr.toString('ascii'),
                timestamp: new Date().getTime()
            };
            instanceLogModel.createOrUpdate(actionLog._id, instance._id, instanceLog, function(err, logData) {
                if (err) {
                    logger.error("Failed to create or update instanceLog: ", err);
                }
            });
        });
    }
};

function removeScriptFile(filePath) {
    fileIo.removeFile(filePath, function(err, result) {
        if (err) {
            logger.error(err);
            return;
        } else {
            logger.debug("Successfully Remove file");
            return
        }
    })
}

var ScriptTask = mongoose.model('scriptTask', scriptTaskSchema);
module.exports = ScriptTask;
