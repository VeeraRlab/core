
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
var deployPermission = require('_pr/model/app-deploy/deploy-permission');
var async = require("async");

const errorType = 'DeployPermission';

var appDeployPermissionService = module.exports = {};

appDeployPermissionService.getDeployPermissionByProjectIdEnvNameAppNameVersion=function getDeployPermissionByProjectIdEnvNameNodeIdVersion(projectId,envName,appName,version,callback){
    async.waterfall([
        function(next){
            deployPermission.getDeployPermissionByProjectIdEnvNameAppNameVersion(projectId,envName,appName,version,next);
        }
    ],function(err,results){
        if (err) {
            logger.error("Error while fetching Project Deploy Permission via projectId in App Deploy "+err);
            callback(err,null);
            return;
        }else{
            callback(null,results);
            return;
        }
    });
}

appDeployPermissionService.saveAndUpdateDeployPermission=function saveAndUpdateDeployPermission(aDeployPermission,callback){
    async.waterfall([
        function(next){
            deployPermission.getDeployPermissionByProjectIdEnvNameAppNameVersion(aDeployPermission.projectId,aDeployPermission.envName,aDeployPermission.appName,aDeployPermission.version,next);
        },
        function(deployPermission,next){
            if(deployPermission.length > 0){
                deployPermission.updateDeployPermission(aDeployPermission,next);
            }else{
                deployPermission.saveDeployPermission(aDeployPermission, next);
            }
        }
    ],function(err,results){
        if(err){
            logger.error("Error in Save or Update App Deploy Permission "+err);
            callback(err,null);
            return;
        }else{
            callback(null,results);
            return;
        }
    })
}







