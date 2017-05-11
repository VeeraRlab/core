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
var yml = require('json2yaml');
var uuid = require('node-uuid');
var appConfig = require('_pr/config');
var fileIo = require('_pr/lib/utils/fileio');
var fileUpload = require('_pr/model/file-upload/file-upload');
const exec = require('child_process').exec;
var logsDao = require('_pr/model/dao/logsdao.js');
var SSHExec = require('_pr/lib/utils/sshexec');
var instanceLogModel = require('_pr/model/log-trail/instanceLog.js');
var instancesDao = require('_pr/model/classes/instance/instance.js');


const errorType = 'commonService';

var commonService = module.exports = {};

commonService.convertJson2Yml = function convertJson2Yml(reqBody,callback){
    var commonJson = {
        id:reqBody.name.toLowerCase().replace(" ","_")+'_'+ uuid.v4().split("-")[0],
        name:reqBody.name,
        desc:reqBody.desc,
        action:reqBody.action,
        type:reqBody.type,
        functionality:reqBody.category,
        subType:reqBody.subType ?reqBody.subType:(reqBody.blueprintType?reqBody.blueprintType:null),
        manualExecutionTime: parseInt(reqBody.standardTime),
        inputFormFields:[],
        execution:[],
        outputOptions:{
            msgs:{
                mail:{},
                text:{}
            }
        }
    }
    if(reqBody.filters){
        commonJson.outputOptions.filters = reqBody.filters;
    }
    if(reqBody.messages){
        commonJson.outputOptions.msgs = reqBody.messages;
    }
    if(reqBody.logs){
        commonJson.outputOptions.logs = reqBody.logs;
    }
    if(reqBody.type ==='script'){
        reqBody.scriptDetails.forEach(function(scriptDetail){
            var params = '';
            scriptDetail.scriptParameters.forEach(function(param){
                commonJson.inputFormFields.push({
                    default : param.paramVal,
                    type : param.paramType === ""?"text":param.paramType.toLowerCase(),
                    label : param.paramDesc,
                    name : param.paramDesc.toLowerCase().replace(" ","_")
                })
                params = params + '${'+ param.paramDesc.toLowerCase().replace(" ","_") + '}'
            })
            commonJson.execution.push({
                type:reqBody.scriptTypeName.toLowerCase(),
                os:reqBody.scriptTypeName === 'Bash' || reqBody.scriptTypeName === 'Python' ?"ubuntu":"windows",
                stage:"Script",
                param:params,
                entrypoint:scriptDetail.scriptId
            })
            commonJson.outputOptions.msgs.text = "Script ${scripName} has executed successful on Node ${node}";
        })
    }else if(reqBody.type ==='jenkins'){
        commonJson.isParameterized = reqBody.isParameterized;
        commonJson.autoSync = reqBody.autoSyncFlag;
        commonJson.inputFormFields.push(
            {
                default : reqBody.jenkinsServerId,
                type : 'list',
                label : 'Jenkins Server Name',
                name : 'jenkinsServerId'
            },
            {
                default : reqBody.jobName,
                type : 'text',
                label : 'Jenkins JOB Name',
                name : 'jenkinsJobName'
            },
            {
                default : reqBody.jobURL,
                type : 'text',
                label : 'Jenkins JOB URL',
                name : 'jenkinsJobURL'
            }
        )
        if(reqBody.isParameterized === true){
            commonJson.inputFormFields.push({
                default : reqBody.parameterized,
                type : 'list',
                label : 'Jenkins JOB Parameters',
                name : 'jenkinsJobParameters'
            })
            commonJson.execution.push({
                type : reqBody.type,
                param : "${jenkinsJobName} ${jenkinsServerId} ${jenkinsJobURL} ${jenkinsJobParameters}",
                entrypoint : reqBody.jobName,
                parameterized: reqBody.parameterized
            })
        }else{
            commonJson.execution.push({
                type : reqBody.type,
                param : "${jenkinsJobName} ${jenkinsServerId} ${jenkinsJobURL}",
                entrypoint : reqBody.jobName,
                jenkinsServerName : reqBody.jenkinsServerName
            })
        }
        commonJson.outputOptions.msgs.text = "${jenkinsJobName} job has successfully built on ${jenkinsServerName}";
    }else if(reqBody.type ==='chef'){
        if(reqBody.attributes && (reqBody.attributes !== null || reqBody.attributes.length > 0)){
            var attributeObj = {},jsonObjKey = '';
            reqBody.attributes.forEach(function(attribute){
                if(Object.keys(attributeObj).length === 0){
                    attributeObj = attribute.jsonObj;
                    jsonObjKey = Object.keys(attribute.jsonObj)[0];
                    var attrValObj = attribute.jsonObj[Object.keys(attribute.jsonObj)[0]];
                    var key  = Object.keys(attrValObj)[0];
                    attributeObj[jsonObjKey][key] = '${'+key+'}';
                }else{
                    var attrValObj = attribute.jsonObj[Object.keys(attribute.jsonObj)[0]];
                    var key  = Object.keys(attrValObj)[0];
                    attributeObj[jsonObjKey][key] = '${'+key+'}';
                }
                commonJson.inputFormFields.push({
                    default : attrValObj[key],
                    type : 'text',
                    label : attribute.name,
                    name : key
                })
            });
            commonJson.execution.push({
                type : 'cookBook',
                os : reqBody.os?reqBody.os:'ubuntu',
                attributes:attributeObj,
                param : "${runlist} ${attributes}",
                runlist:reqBody.runlist,
                stage : reqBody.name
            })
        }else{
            commonJson.execution.push({
                type : 'cookBook',
                os : reqBody.os,
                attributes:null,
                param : "${runlist}",
                runlist:reqBody.runlist,
                stage : reqBody.name
            })
        }
        commonJson.outputOptions.msgs.text = "Cookbook RunList ${runlist} has executed successful on Node ${node}";
    }else if(reqBody.type ==='blueprints' || reqBody.type ==='blueprint'){
        if(reqBody.subType === 'aws_cf' || reqBody.subType === 'azure_arm'){
            commonJson.inputFormFields.push(
                {
                    default : reqBody.stackName?reqBody.stackName:null,
                    type : 'text',
                    label : 'Stack Name',
                    name : 'stackName'
                })
        }else{
            commonJson.inputFormFields.push(
                {
                    default : reqBody.domainName?reqBody.domainName:null,
                    type : 'text',
                    label : 'Domain Name',
                    name : 'domainName'
                })
        }
        commonJson.inputFormFields.push(
            {
                default : reqBody.blueprintIds?reqBody.blueprintIds:[],
                type : 'list',
                label : 'Blueprint Name',
                name : 'blueprintIds'
            },
            {
                default : reqBody.envId?reqBody.envId:[],
                type : 'list',
                label : 'Environment Name',
                name : 'envId'
            },
            {
                default : reqBody.monitorId?reqBody.monitorId:[],
                type : 'list',
                label : 'Monitor Name',
                name : 'monitorId'
            },
            {
                default : reqBody.tagServer?reqBody.tagServer:[],
                type : 'list',
                label : 'Tag Server',
                name : 'tagServer'
            }
        )
        commonJson.execution.push({
            type : reqBody.type,
            name : reqBody.blueprintName,
            id : reqBody.blueprintId,
            category : getBlueprintType(reqBody.blueprintType)
        })
        commonJson.outputOptions.msgs.text = "${blueprintName} has successfully launched on env ${envId}";
    }
    var ymlText = yml.stringify(commonJson);
    commonJson.category = reqBody.category;
    commonJson.orgId = reqBody.orgId;
    commonJson.orgName = reqBody.orgName;
    commonJson.source = "Catalyst";
    var fileName = appConfig.tempDir + commonJson.id + '.yaml';
    fileIo.writeFile(fileName,ymlText,null,function(err){
        if(err){
            logger.error(err);
            callback(err,null);
            return;
        }else{
            logger.debug("Successfully write file");
            fileUpload.uploadFile(commonJson.id + '.yaml',fileName,null,function(err,data) {
                if (err) {
                    logger.error(err);
                    callback(err, null);
                    fileIo.removeFile(fileName,function(err,removeCheck){
                        if(err){
                            logger.error(err);
                        }
                        logger.debug("Successfully remove file");
                    })
                    return;
                } else {
                    commonJson.ymlDocFileId = data;
                    callback(null,commonJson);
                    fileIo.removeFile(fileName,function(err,removeCheck){
                        if(err){
                            logger.error(err);
                        }
                        logger.debug("Successfully remove file");
                    })
                    return;
                }
            });
        }
    })
}

commonService.executeCmd = function executeCmd(sshOptions,instanceLog,instanceId,actionId,actionLogId,botId,bot_id,cmd,callback){
    if(sshOptions === null){
        var errorCheck = false;
        exec(cmd, function(err, stdout, stderr) {
            if (err) {
                logger.error(err);
                callback(err,null);
                return;
            }
            if(stdout){
                var timestampEnded = new Date().getTime();
                logsDao.insertLog({
                    botId: botId,
                    botRefId: actionLogId,
                    err: false,
                    log: stdout.toString("ascii"),
                    timestamp: timestampEnded
                });
            }
            if(stderr){
                errorCheck = true;
                var timestampEnded = new Date().getTime();
                logsDao.insertLog({
                    botId: botId,
                    botRefId: actionLogId,
                    err: true,
                    log: stderr.toString("ascii"),
                    timestamp: timestampEnded
                });
            }
        })
        callback(null,errorCheck);
        return;
    }else{
        var sshExec = new SSHExec(sshOptions);
        sshExec.exec(cmd, function (err, retCode) {
            if (err) {
                var timestampEnded = new Date().getTime();
                logsDao.insertLog({
                    instanceId:instanceId,
                    instanceRefId:actionId,
                    botId: botId,
                    botRefId: actionLogId,
                    err: true,
                    log: 'Unable to run Bot : '+bot_id,
                    timestamp: timestampEnded
                });
                instancesDao.updateActionLog(instanceId, actionId, false, timestampEnded);
                instanceLog.endedOn = new Date().getTime();
                instanceLog.actionStatus = "failed";
                instanceLogModel.createOrUpdate(actionId, instanceId, instanceLog, function (err, logData) {
                    if (err) {
                        logger.error("Failed to create or update instanceLog: ", err);
                    }
                });
              callback(err,null);
            }else if (retCode === 0) {
                var timestampEnded = new Date().getTime();
                logsDao.insertLog({
                    instanceId:instanceId,
                    instanceRefId:actionId,
                    botId: botId,
                    botRefId: actionLogId,
                    err: false,
                    log: 'BOT execution has success for BOT : ' + bot_id,
                    timestamp: timestampEnded
                });
                instancesDao.updateActionLog(instanceId, actionId, true, timestampEnded);
                instanceLog.endedOn = new Date().getTime();
                instanceLog.actionStatus = "success";
                instanceLogModel.createOrUpdate(actionId, instanceId, instanceLog, function (err, logData) {
                    if (err) {
                        logger.error("Failed to create or update instanceLog: ", err);
                    }
                });
                callback(null,bot_id);
                return;
            } else {
                if (retCode === -5000) {
                    logsDao.insertLog({
                        instanceId: instanceId,
                        instanceRefId: actionId,
                        botId: botId,
                        botRefId: actionLogId,
                        err: true,
                        log: 'Host Unreachable',
                        timestamp: new Date().getTime()
                    });
                    instanceLog.endedOn = new Date().getTime();
                    instanceLog.actionStatus = "failed";
                    instanceLogModel.createOrUpdate(actionId, instanceId, instanceLog, function (err, logData) {
                        if (err) {
                            logger.error("Failed to create or update instanceLog: ", err);
                        }
                    });
                    callback(null, bot_id);
                    return;
                } else if (retCode === -5001) {
                    logsDao.insertLog({
                        instanceId: instanceId,
                        instanceRefId: actionId,
                        botId: botId,
                        botRefId: actionLogId,
                        err: true,
                        log: 'Invalid credentials',
                        timestamp: new Date().getTime()
                    });
                    instanceLog.endedOn = new Date().getTime();
                    instanceLog.actionStatus = "failed";
                    instanceLogModel.createOrUpdate(actionId, instanceId, instanceLog, function (err, logData) {
                        if (err) {
                            logger.error("Failed to create or update instanceLog: ", err);
                        }
                    });
                    callback(null, bot_id);
                    return;
                } else {
                    logsDao.insertLog({
                        instanceId: instanceId,
                        instanceRefId: actionId,
                        botId: botId,
                        botRefId: actionLogId,
                        err: true,
                        log: 'Unknown error occured. ret code = ' + retCode,
                        timestamp: new Date().getTime()
                    });
                    instanceLog.endedOn = new Date().getTime();
                    instanceLog.actionStatus = "failed";
                    instanceLogModel.createOrUpdate(actionId, instanceId, instanceLog, function (err, logData) {
                        if (err) {
                            logger.error("Failed to create or update instanceLog: ", err);
                        }
                    });
                    callback(null, bot_id);
                    return;
                }
            }
        }, function (stdOut) {
            logsDao.insertLog({
                instanceId:instanceId,
                instanceRefId:actionId,
                botId: botId,
                botRefId: actionLogId,
                err: false,
                log: stdOut.toString('ascii'),
                timestamp: new Date().getTime()
            });
        }, function (stdErr) {
            logsDao.insertLog({
                instanceId:instanceId,
                instanceRefId:actionId,
                botId: botId,
                botRefId: actionLogId,
                err: true,
                log: stdErr.toString('ascii'),
                timestamp: new Date().getTime()
            });
        });
    }
}

function getBlueprintType(type){
    var blueprintType = '';
    switch(type) {
        case 'chef':
            blueprintType ="Software Stack";
            break;
        case 'ami':
            blueprintType ="OS Image";
            break;
        case 'docker':
            blueprintType ="Docker";
            break;
        case 'arm':
            blueprintType ="ARM Template";
            break;
        case 'cft':
            blueprintType ="Cloud Formation";
            break;
        default:
            blueprintType ="Software Stack";
            break
    }
    return blueprintType;
}



