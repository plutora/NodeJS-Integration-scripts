/*
GOAL:
- Get Pull Request from GitHub and connect them to changes

PATHING:
GET /changes
POST /changes

changes with type = User Stories

TODO:
- default 

NOTES:


GitHub API side:
https://api.github.com/repos/plutora/c1/pulls


*/
const https = require('https')
const querystring = require('querystring')


//////////// Config ////////////
const config = {
    plutora: {
        oauthUrl: 'auoauth.plutora.com',
        clientId: '',
        clientSecret: '',
        username: '',
        password: '',
        apiUrl: 'auapi.plutora.com'
    },
    github: {
        access_token: 'cc3650d1afb3df855236b77f762c1e06145f9eca',
        apiUrl: 'api.github.com'
    }
}

//////////// Script's Globals ////////////
let plutoraAccessToken, pullRequests, allExistingChangesName, allExistingChangesID, pullRequestChangeType,
deliveryRisks, changeThemes, changePriorities;


//////////// Plutora API Calls ////////////
const plutora = {
    plutoraGetAccessToken: function() {
        return new Promise((resolve, reject) => {
            let body = '';
            let data = querystring.stringify({
                client_id: config.plutora.clientId,
                client_secret: config.plutora.clientSecret,
                grant_type: 'password',
                username: config.plutora.username,
                password: config.plutora.password
            });

        let options = {
            method: 'POST',
            rejectUnauthorized: false,
            hostname: config.plutora.oauthUrl,
            path: '/oauth/token',
            headers: {
                'Content-Type': 'x-www-form-urlencoded; charset=urf-8',
                Accept: 'application/json'
            }
        };

        let req = https.request(options, res => {
            res.setEncoding('utf8');
            res.on('data', function(chunk) {
                body += chunk;
            });
            res.on('end', () => {
            result = JSON.parse(body);
            console.log(
                '<<< Got Plutora Access Token >>>' // , JSON.stringify(result.access_token)
            );
            resolve(result.access_token);
            });
            res.on('error', error => {
                console.error(error);
                reject(error);
            });
        });
        req.write(data, 'utf-8', d => {
        //console.log('Done flushing...', d);
        });
        req.end();
    });
    },
    plutoraRequest: function(reqType, apipath, data) {
        return new Promise(function(resolve, reject) {
            let body = '';
            let req = https.request({
                    method: reqType, // 'GET', 'POST'
                    host: config.plutora.apiUrl,
                    port: 443,
                    path: '/' + apipath,
                    rejectUnauthorized: false,
                    headers: {
                        Authorization: 'bearer ' + plutoraAccessToken,
                        'Content-Length': data ? Buffer.byteLength(data) : 0,
                        'Content-Type': 'application/json'
                    }
                },
                function(res) {
                    res.on('data', chunk => {
                        body += chunk;
                    })
                    res.on('end', () => {
                        if (body) { //in the case PUT returns no response
                            if (res.statusCode >= 200 && res.statusCode < 300) {
                                result = JSON.parse(body)
                                resolve(result)
                            }
                            else {
                                reject(body)
                            }
                        }
                        else {
                            resolve({})
                        }
                    })
                    res.on('error', error => {
                        console.error('Error: ', error.message);
                        reject(error);
                    })
                }
            )
            if (data) req.write(data)
            else req.write('')
            req.end(function(e) {
                if (data) {
                    console.log(
                    '##### Plutora request complete:',
                    data,
                    config.plutora.apiUrl + '/' + apipath,
                    reqType,
                    '#####'
                    )
                } 
                else {
                    console.log(
                    '##### Plutora request complete:',
                    config.plutora.apiUrl + '/' + apipath,
                    reqType,
                    '#####'
                    )
                }
            })
        })
    }
}

//////////// GitHub API Calls ////////////
const github = {
    githubRequest: ( reqtype, apipath, data ) => {
        return new Promise((resolve, reject) => {
                let body = '';
                let req = https.request({
                    method: reqtype, // API verbs
                    host: config.github.apiUrl,
                    path: '/' + apipath,
                    rejectUnauthorized: false,
                    headers: {
                        "Authorization": config.github.access_token,
                        "cache-control": "no-cache",
                        "User-Agent": "Here2Huynh"
                    }
                },
                (res) => {
                    res.on('data', chunk => {
                        body += chunk;
                    })
                    res.on('end', () => {
                        if (body) {
                            if ( res.statusCode >= 200 && res.statusCode < 300 ) {
                                result = JSON.parse(body)
                                resolve(result)
                            }
                            else {
                                reject(body)
                            }
                        }
                    })
                    res.on('error', error => {
                        console.error('Error: ', error.message);
                        reject(error);
                    })
                }
            )
            if ( data ) req.write(data)
            else req.write('')
            req.end(e => {
                if ( data ) {
                    console.log(
                        '##### GitHub request complete: ',
                        data,
                        config.github.apiUrl + '/' + apipath,
                        reqtype,
                        '#####'
                    )
                }
                else {
                    console.log(
                        '##### GitHub request complete: ',
                        config.github.apiUrl + '/' + apipath,
                        reqtype,
                        '#####'
                    )
                }
            })
        })
    }
}

///////////////////////////////////////////

// initialize config with instance's variables 
const initConfig = function(args) {
    try {
        config.lastRunDate = new Date(args.lastRunDateUtc)
        config.lastSuccessfulRunDate = new Date(args.lastSuccessfulRunDateUtc)
        console.log('lastRunDate', config.lastRunDate)
        console.log('lastSuccessfulRunDate', config.lastSuccessfulRunDate)

        if (
        !args.arguments.clientId ||
        !args.arguments.clientSecret ||
        !args.arguments.username ||
        !args.arguments.password
        )
        throw new Error(
            'Missing required params. Required params are: plutoraClientId, plutoraClientSecret, plutoraUsername and plutoraPassword'
        );

        config.plutora.clientId = args.arguments.clientId
        config.plutora.clientSecret = args.arguments.clientSecret
        config.plutora.username = args.arguments.username
        config.plutora.password = args.arguments.password
    } 
    catch (err) {
        console.log(err)
        return false
    }
    return true
};

///////// Help functions /////////
// async forEach to iterate through project in csv file
const asyncForEach = async function (array, callback) {
    for ( let index = 0; index < array.length; index++ ) {
        await callback(array[index], index, array)
    }
}

// pretty print objs
const prettyPrint = (label, obj) => {
    console.log(label, JSON.stringify(obj))
}

// async setTimeout function to for API throttling
// the sheer amount of systems they have, might need to extend the DELAY_RATE to avoid crapping out the API server
const DELAY_RATE = 300;
async function wait(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms)
    })
}

////////////////////////////////////////////////////////
//////// Plutora API data loading functions ////////

// get pull requests from GitHub
const getPullRequests = async function() {
    console.log('<<< Getting from GitHub >>>')
    pullRequests = await github.githubRequest(
        'GET',
        'repos/plutora/c1/pulls'
    )
    // prettyPrint('pullRequests', pullRequests)
}


////////////////////////////////////////////////////////

////////////////////////////////////////////////////////
//////// Plutora API data loading functions ////////

// get organiztions from plutora
const createNewChange = async function(newChangeData) {
    console.log(`<<< Creating new change with info (${JSON.stringify(newChangeData)}) >>>`)
    return await plutora.plutoraRequest(
        'POST',
        'changes',
        JSON.stringify(newChangeData)
    )
    // .then(data => {
    //     return data.reduce((map,obj) => {
    //         map[obj.name] = obj
    //         return map
    //     },{})
    // })
}

// get a change by its ID
const getChangeByID = async function(changeID) {
    try {
        return await plutora.plutoraRequest(
            'GET',
            `changes/${changeID}`
        )
    }
    catch (err) {
        console.error(`<<< Issue getting change with (${changeID})  with error ${err} >>>`)
    }
}

// get linked changes
const getChangesLinkedChanges = async function(changeID) {
    try {
        return await plutora.plutoraRequest(
            'GET',
            `changes/${changeID}/linkedChanges`
        )
    }
    catch (err) {
        console.error(`<<< Issue getting linked changes (${changeID})  with error ${err} >>>`)
    }
}

// update linked changes
const updateChangesLinkedChanges = async function(changeID, linkedChangesInfo) {
    console.log(`<<< Updating linked changes of Change: (${changeID}) >>>`)
    try {
        return await plutora.plutoraRequest(
            'PUT',
            `changes/${changeID}/linkedChanges`,
            JSON.stringify(linkedChangesInfo)
        )
    }
    catch (err) {
        console.error(`<<< Issue updating linked changes (${changeID})  with error ${err} >>>`)
    }
}


// update change by its ID
const updateChange = async function(changeID, updateChangeInfo) {
    console.log(`<<< Updating change (${changeID}) >>>`)
    try {
        await plutora.plutoraRequest(
            'PUT',
            `changes/${changeID}`,
            JSON.stringify(updateChangeInfo)
        )
    }
    catch (err) {
        console.error(`<<< Issue updating change (${changeID})  with error ${err} >>>`)
    }

}

// get all changes 
const getAllChanges = async function() {
    allExistingChangesName = await plutora.plutoraRequest(
        'GET',
        '/changes'
    )

    allExistingChangesID = allExistingChangesName

    allExistingChangesName = allExistingChangesName.reduce((map, obj) => {
        map[ obj['name'] ] = obj
        return map
    },{})
    

    allExistingChangesID = allExistingChangesID.reduce((map, obj) => {
        map[ obj['id'] ] = obj
        return map
    },{})
    
        // prettyPrint('allExistingChangesName', allExistingChangesName)
        // prettyPrint('allExistingChangesID', allExistingChangesID)
}

// base lookupfield function to get IDs of entities
const getLookupFields = async function (type) {
    try{
        return await plutora.plutoraRequest(
            'GET',
            'lookupfields/' + type 
        ).then((data) => {
            // const results = JSON.parse(data)
            return data.reduce(function (map,obj) {
                map[obj.value] = obj
                return map
            },{})
        })
    }
    catch (err) {
        console.error(`<<< Error getting lookupField for ${type} >>>`)
    }
}

// function to map pull requests to changes
const mapPullRequestsToChanges = async function() {
    await asyncForEach(pullRequests, async(pullRequest) => {
        // prettyPrint('pullRequest', pullRequest)
        // prettyPrint(`pullRequest['head']`, pullRequest.base.repo.name)

        let JIRAid = pullRequest.title.split(' ')[0]
        prettyPrint('JIRAid', JIRAid)

        // let foundChange = await getChangeByID("0328e9e2-a934-e911-a982-f2cb536a8f94") // static for the sake of speed
        // prettyPrint('foundChange', foundChange)
        // prettyPrint('foundChange.additionalInformation', foundChange.additionalInformation)



        if ( !allExistingChangesName[pullRequest.title] ) {
            let description = [
                `Repository Name: ${pullRequest.base.repo.name} <br>`,
                `User: ${pullRequest.user.login}<br>`,
                `Updated in GitHub at ${pullRequest.updated_at} <br>`,
                `Commit ID: ${pullRequest.merge_commit_sha} <br>`,
                `View Commits at ${pullRequest.commits_url} <br>`,
                `View comments at ${pullRequest.review_comments_url} <br>`,
                `JIRA link: ${pullRequest.body} <br>`
            ]
            
            let  newChangeInfo = {
                "id": null,
                "name": pullRequest.title,
                "changeId": null, //17
                "changePriorityId": changePriorities["Medium Priority"].id,
                "changePriority": "Medium Priority",
                "changeStatusId": changeStatuses["Draft"].id,
                "changeStatus": "Draft",
                "businessValueScore": null, // 80
                "raisedById": "89982734-9d61-4966-8e27-26e834e73116",
                "raisedBy": "Boba Fett",
                "raisedDate": pullRequest.created_at, 
                "organizationId": "3c31ad6f-4b51-e811-a981-ee34a4e98dd2", 
                "organization": "Mobile and Online Banking", //
                "changeTypeId": pullRequestChangeType["Pull Request"].id,
                "changeType": "Pull Request",
                "changeDeliveryRiskId": deliveryRisks['Low'].id,
                "changeDeliveryRisk": "Low",
                "expectedDeliveryDate": "2018-04-24T00:00:00",
                "changeThemeId": changeThemes["Competitiveness"].id,
                "changeTheme": "Competitiveness",
                "description": description.join(''),
                "descriptionSimple": "",
                "lastModifiedDate": null,
                "lastModifiedBy": null,
                "additionalInformation": [
                    {
                        "id": "8e125ef5-7626-e811-a980-fc49c3e38ffc",
                        "name": "JIRA ID",
                        "type": "Change",
                        "dataType": "FreeText",
                        "text": `${JIRAid}`,
                        "time": null,
                        "date": null,
                        "number": null,
                        "decimal": null,
                        "dateTime": null,
                        "listItem": null,
                        "multiListItem": null
                    },
                    {
                        "id": "a15b4092-a978-e811-a982-f2cb536a8f94",
                        "name": "LEAD TIME",
                        "type": "Change",
                        "dataType": "Number",
                        "text": null,
                        "time": null,
                        "date": null,
                        "number": null,
                        "decimal": null,
                        "dateTime": null,
                        "listItem": null,
                        "multiListItem": null
                    },
                    {
                        "id": "a35b4092-a978-e811-a982-f2cb536a8f94",
                        "name": "TOUCH TIME",
                        "type": "Change",
                        "dataType": "Number",
                        "text": null,
                        "time": null,
                        "date": null,
                        "number": null,
                        "decimal": null,
                        "dateTime": null,
                        "listItem": null,
                        "multiListItem": null
                    },
                    {
                        "id": "a25b4092-a978-e811-a982-f2cb536a8f94",
                        "name": "WAIT TIME",
                        "type": "Change",
                        "dataType": "Number",
                        "text": null,
                        "time": null,
                        "date": null,
                        "number": null,
                        "decimal": null,
                        "dateTime": null,
                        "listItem": null,
                        "multiListItem": null
                    }
                ],
                "stakeholders": [
                    {
                        "userId": "76713feb-3b26-e811-a980-fc49c3e38ffc",
                        "user": "Richard Winslow",
                        "groupId": null,
                        "group": "",
                        "stakeholderRoleIds": [
                            "11409840-0e20-e811-a980-fc49c3e38ffc"
                        ],
                        "stakeholderRoles": "Release Manager",
                        "responsible": false,
                        "accountable": false,
                        "informed": false,
                        "consulted": false
                    }
                ],
                "systems": [
                    {
                        "systemId": "f0cb0cb4-5551-e811-a981-ee34a4e98dd2",
                        "name": "Authorization Server",
                        "systemRoleType": "Impact"
                    }
                ],
                "deliveryReleases": [],
                "comments": []
            }
    
            // prettyPrint('newChangeInfo', newChangeInfo)
    
            let createdChange = await createNewChange(newChangeInfo)
            prettyPrint('createdChange', createdChange)

            // if ( JIRAid === createdChange.additionalInformation[0].text ) {
                // await getChangesLinkedChanges("0328e9e2-a934-e911-a982-f2cb536a8f94")
    
                // let foundChange = await getChangeByID("")
    
                let linkedChangeInfo = {
                    "childChanges": [
                        {
                            "id": "0328e9e2-a934-e911-a982-f2cb536a8f94",
                        }
                    ],
                    "parentChanges": [
                    ],
                    "relatedChanges": []
                }
                let updateLinkedChanges = await updateChangesLinkedChanges(createdChange.id, linkedChangeInfo)
                prettyPrint('Linked changes has been added to Change', updateLinkedChanges)
            // }
        }

        else if ( allExistingChangesName[pullRequest.title] ) {
            let description = [
                `Repository Name: ${pullRequest.base.repo.name} <br>`,
                `User: ${pullRequest.user.login}<br>`,
                `Updated in GitHub at ${pullRequest.updated_at} <br>`,
                `Commit ID: ${pullRequest.merge_commit_sha} <br>`,
                `View Commits at ${pullRequest.commits_url} <br>`,
                `View comments at ${pullRequest.review_comments_url} <br>`,
                `JIRA link: ${pullRequest.body} <br>`
            ]

            let updateInfo = {
                "id": allExistingChangesName[pullRequest.title].id,
                "additionalInformation": [
                    {
                        "id": "8e125ef5-7626-e811-a980-fc49c3e38ffc",
                        "name": "JIRA ID",
                        "type": "Change",
                        "dataType": "FreeText",
                        "text": `${JIRAid}`,
                        "time": null,
                        "date": null,
                        "number": null,
                        "decimal": null,
                        "dateTime": null,
                        "listItem": null,
                        "multiListItem": null
                    },
                    {
                        "id": "a15b4092-a978-e811-a982-f2cb536a8f94",
                        "name": "LEAD TIME",
                        "type": "Change",
                        "dataType": "Number",
                        "text": null,
                        "time": null,
                        "date": null,
                        "number": null,
                        "decimal": null,
                        "dateTime": null,
                        "listItem": null,
                        "multiListItem": null
                    },
                    {
                        "id": "a35b4092-a978-e811-a982-f2cb536a8f94",
                        "name": "TOUCH TIME",
                        "type": "Change",
                        "dataType": "Number",
                        "text": null,
                        "time": null,
                        "date": null,
                        "number": null,
                        "decimal": null,
                        "dateTime": null,
                        "listItem": null,
                        "multiListItem": null
                    },
                    {
                        "id": "a25b4092-a978-e811-a982-f2cb536a8f94",
                        "name": "WAIT TIME",
                        "type": "Change",
                        "dataType": "Number",
                        "text": null,
                        "time": null,
                        "date": null,
                        "number": null,
                        "decimal": null,
                        "dateTime": null,
                        "listItem": null,
                        "multiListItem": null
                    }
                ],
                "stakeholders": [
                    {
                        "userId": "76713feb-3b26-e811-a980-fc49c3e38ffc",
                        "user": "Richard Winslow",
                        "groupId": null,
                        "group": "",
                        "stakeholderRoleIds": [
                            "11409840-0e20-e811-a980-fc49c3e38ffc"
                        ],
                        "stakeholderRoles": "Release Manager",
                        "responsible": false,
                        "accountable": false,
                        "informed": false,
                        "consulted": false
                    }
                ],
                "systems": [
                    {
                        "systemId": "f0cb0cb4-5551-e811-a981-ee34a4e98dd2",
                        "name": "Authorization Server",
                        "systemRoleType": "Impact"
                    }
                ],
                "deliveryReleases": [],
                "comments": [],
                "name": pullRequest.title,
                "changePriorityId": changePriorities["Medium Priority"].id,
                "changeStatusId": changeStatuses["Draft"].id,
                "businessValueScore": null,
                "raisedById": "89982734-9d61-4966-8e27-26e834e73116",
                "organizationId": "3c31ad6f-4b51-e811-a981-ee34a4e98dd2",
                "changeTypeId": pullRequestChangeType["Pull Request"].id,
                "changeDeliveryRiskId": deliveryRisks['Low'].id,
                "expectedDeliveryDate": null,
                "changeThemeId": changeThemes["Competitiveness"].id,
                "description": description.join('')
            }
            
            await updateChange(allExistingChangesName[pullRequest.title].id, updateInfo)

            let foundChange = await getChangeByID(allExistingChangesName[pullRequest.title].id)
            if ( JIRAid === foundChange.additionalInformation[0].text ) {
                // await getChangesLinkedChanges("0328e9e2-a934-e911-a982-f2cb536a8f94")
                
                let linkedChangeInfo = {
                    "childChanges": [
                        {
                            "id": "0328e9e2-a934-e911-a982-f2cb536a8f94",
                        }
                    ],
                    "parentChanges": [
                    ],
                    "relatedChanges": []
                }
                let updateLinkedChanges = await updateChangesLinkedChanges(foundChange.id, linkedChangeInfo)
                prettyPrint('Linked changes has been added to Change', updateLinkedChanges)
            }
        }

    })
}

///////// Run function /////////
let run = async function (args) {
    if ( !initConfig(args) ) return

    try {
        plutoraAccessToken = await plutora.plutoraGetAccessToken()

        await getPullRequests()

        await getAllChanges()
        pullRequestChangeType = await getLookupFields('ChangeType') // pullRequestChangeType["Pull Request"]
        deliveryRisks = await getLookupFields('ChangeDeliveryRisk') // deliveryRiskID['ChangeDeliveryRisk']
        changeThemes = await getLookupFields('ChangeTheme') // ChangeTheme
        changePriorities = await getLookupFields('ChangePriority') // ChangePriority
        changeStatuses = await getLookupFields('ChangeStatus') // ChangeStatus

        // let foundChange = await getChangeByID("0328e9e2-a934-e911-a982-f2cb536a8f94") // static for the sake of speed
        // prettyPrint('foundChange', foundChange)
        // prettyPrint('foundChange.additionalInformation', foundChange.additionalInformation[0].text)

        await mapPullRequestsToChanges()
    }
    catch (err) {
        console.error(err)
        throw err
    }

    console.log('##### DONE #####')
}

module.exports = {
    run: run
}
