const AWS = require('aws-sdk')
const https = require('https')
const querystring = require('querystring')

const TASK_POLLING_FREQUENCY_MS = 5000;
const AWS_STACK_STATUS_COMPLETE_CODES = ['CREATE_COMPLETE', 'CREATE_FAILED', 'ROLLBACK_COMPLETE', 'ROLLBACK_FAILED'];

//TODO get these from the lookups endpoint
const PLUTORA_ENVIRONMENT_STATUS_ACTIVE = '05d7f8d0-d320-e811-a980-fc49c3e38ffc';
const PLUTORA_ENVIRONMENT_STATUS_DECOMMISIONED = '2e4ed4e9-d320-e811-a980-fc49c3e38ffc';
const PLUTORA_TEBR_FAILED = '2679af0a-a376-e911-a982-f2cb536a8f94';
const PLUTORA_TEBR_COMPLETED = '8ec5cb9d-d420-e811-a980-fc49c3e38ffc';
const PLUTORA_STACK_LAYER_ID_APPLICATION = '4c409840-0e20-e811-a980-fc49c3e38ffc';
const PLUTORA_STACK_LAYER_ID_DATABASE = '37b12529-43b5-e811-a983-fee0ec43c416';
const PLUTORA_STACK_LAYER_ID_MIDDLEWARE = '3ab12529-43b5-e811-a983-fee0ec43c416';
const PLUTORA_STACK_LAYER_ID_NETWORK = 'dbb02529-43b5-e811-a983-fee0ec43c416';
const PLUTORA_STACK_LAYER_ID_OPERATING_SYSTEM = 'dfb02529-43b5-e811-a983-fee0ec43c416';
const PLUTORA_STACK_LAYER_ID_PACKAGE = 'ef0c4931-3636-e911-a983-fee0ec43c416';

/////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////Helpers//////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////////

const get = (obj, path, defaultValue) =>
  path.split('.').reduce((a, c) => (a && a[c] ? a[c] : defaultValue || null), obj)

function guid() {
  function s4() {
    return Math.floor((1 + Math.random()) * 0x10000)
      .toString(16)
      .substring(1)
  }

  return `${s4()}-${s4()}-${s4()}`
}

Array.prototype.forEachAsync = async function (fn) {
  for (let t of this) { await fn(t) }
}

/////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////Config//////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////////

var config = {
  plutora: {
    oauthUrl: '',
    clientId: '',
    clientSecret: '',
    username: '',
    password: '',
    apiUrl: '',
  },
  aws: {
    accessKeyId: '',
    secretAccessKey: ''
  },
  octopus: {
    octopusAPIKey: '',
    octopusAPIURL: ''
  }
}

// initialize config with instance's variables
// this ensures all the needed parameters set in the job is there and configured correctly
const initConfig = function(args) {
  try {
      // for logging info purposes
      config.lastRunDate = new Date(args.lastRunDateUtc)
      config.lastSuccessfulRunDate = new Date(args.lastSuccessfulRunDateUtc)
      console.log('lastRunDate', config.lastRunDate)
      console.log('lastSuccessfulRunDate', config.lastSuccessfulRunDate)

      if (
      !args.arguments.accessKeyId ||
      !args.arguments.secretAccessKey ||
      !args.arguments.clientId ||
      !args.arguments.clientSecret ||
      !args.arguments.username ||
      !args.arguments.password ||
      !args.arguments.apiUrl ||
      !args.arguments.oauthUrl ||
      !args.arguments.region
      )
      throw new Error(
          '<<< Missing required params. Required params are: clientId, clientSecret, username and password >>>'
      );

      // store set params for script usage

      config.aws.accessKeyId = args.arguments.accessKeyId
      config.aws.secretAccessKey = args.arguments.secretAccessKey
      config.aws.region = args.arguments.region

      config.plutora.clientId = args.arguments.clientId
      config.plutora.clientSecret = args.arguments.clientSecret
      config.plutora.username = args.arguments.username
      config.plutora.password = args.arguments.password
      config.plutora.apiUrl = args.arguments.apiUrl
      config.plutora.oauthUrl = args.arguments.oauthUrl

  }
  catch (err) {
      console.error(err)
      return false
  }
  return true
};

/////////////////////////////////////////////////////////////////////////////////////
////////////////////////////////////Plutora API Calls///////////////////////////////
////////////////////////////////////////////////////////////////////////////////////

const plutora = {
  plutoraGetAccessToken: function() {
    return new Promise(function(resolve, reject) {
      var body = ''
      var data = querystring.stringify({
        client_id: config.plutora.clientId,
        client_secret: config.plutora.clientSecret,
        grant_type: 'password',
        username: config.plutora.username,
        password: config.plutora.password,
      })

      var options = {
        method: 'POST',
        rejectUnauthorized: false,
        hostname: config.plutora.oauthUrl,
        path: '/oauth/token',
        headers: {
          'Content-Type': 'x-www-form-urlencoded; charset=urf-8',
          Accept: 'application/json',
        },
      }

      var req = https.request(options, function(res) {
        //console.log('options', options)
        res.setEncoding('utf8')
        res.on('data', function(chunk) {
          // console.log(chunk)
          body += chunk
        })
        res.on('end', function() {
          //console.log(body)
          result = JSON.parse(body)
          resolve(result.access_token)
        })
        res.on('error', error => {
          console.error('error', error)
          reject(error)
        })
      })
      req.write(data, 'utf-8', function(d) {
        console.log('Done flushing ...', d)
      })
      req.end()
    })
  },

  plutoraRequest: function(bearerToken, reqType, apipath, data) {
    return new Promise(function(resolve, reject) {
      let body = ''
      var req = https.request(
        {
          method: reqType, // 'GET', 'POST'
          host: config.plutora.apiUrl,
          port: 443,
          path: '/' + apipath,
          rejectUnauthorized: false,
          headers: {
            Authorization: 'bearer ' + bearerToken,
            'Content-Length': data ? Buffer.byteLength(data) : 0,

            'Content-Type': 'application/json',
          },
        },
        function(res) {
          res.on('data', function(chunk) {
            body += chunk
          })
          res.on('end', () => {
            try {
              result = JSON.parse(body)
              resolve(result)
            } catch (e) {
              //console.log(e)
              resolve({})
            }
          })
          res.on('error', function(error) {
            console.error(' Error::::::', error)
            reject(error)
          })
        },
      )
      if (data)
        console.log(
          req.write(data, 'utf-8', function(d) {
            console.log('Done flushing ...', d)
          }),
        )
      else req.write('')
      req.end(function(e) {
        console.log('Done request ...', e)
      })
      console.log('%%%%%%%%%%%%%%%%%%%%%%%%%%%%', data, apipath, reqType, '%%%%%%%%%%%%%%%%%%%%%%%')
    })
  },
}

/////////////////////////////////////////////////////////////////////////////////////
////////////////////////////////////AWS API Calls///////////////////////////////
////////////////////////////////////////////////////////////////////////////////////

let run = async function(args) {
  // credentials
  if ( !initConfig(args) ) return

  //configuring the AWS environment
  AWS.config.update({
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
    region: config.aws.region || 'eu-west-2',
  })

  const cloudformation = new AWS.CloudFormation()

  console.log('AWS configured!')
  console.log(JSON.stringify(cloudformation))

  try {
    let plutoraAccessToken = await plutora.plutoraGetAccessToken()
    console.log('Got Plutora Access Token...')
    //console.log('Token',  plutoraAccessToken)

    // fetch TEBRs
    const tebrs = await plutora.plutoraRequest(plutoraAccessToken, 'GET', 'TEBRs')

    if (!tebrs || !tebrs.length) {
      throw new Error('could not fetch TEBRs')
    }

    // filter by status + type
    var filtered = tebrs.filter(
      resp => resp.status === 'Approved' && resp.type === 'AWS Environment',
    )
    // TODO filter by start date?

    if (!filtered || !filtered.length) {
      throw new Error('no TEBRs found with Status = "Approved" & Type = "AWS Environment"')
    }

    // fetch additional info
    const additionalInfo = {};
    await Promise.all(
      filtered.map(obj =>
        plutora.plutoraRequest(plutoraAccessToken, 'GET', `TEBRs/${obj.id}/additionalInformation`).then((f) => {
          additionalInfo[obj.id] = {
            additionalInfo: f,
            tebr: obj,
            id: obj.id
          };
        }),
      ),
    )

    const stackStatusPolling = [];

    await Object.keys(additionalInfo).forEachAsync(async (tebrID) => {
      console.log(`Processing TEBR: ${tebrID}`);

      const entry = additionalInfo[tebrID];

      // fetch cloudformation template from TEBRs field 'template tag'
      const template = entry.additionalInfo.filter(t => t.name === 'Template Tag')

      if (!template || !template.length) {
        throw new Error('no cloudformation templates found')
      }

      const id = guid()
      const stackname = `Plutora-${id}`

      // params for cloudformation stack
      const params = {
        StackName: stackname /* required */,
        Tags: [
          {
            Key: `Plutora-key-${id}` /* required */,
            Value: `Plutora-value-${id}` /* required */,
          },
        ],
        TemplateBody: template[0].text,
      }

      console.log('creating cloudformation template...')
      // create cloudformation stack
      var stackResponse = null;
      await cloudformation.createStack(params).promise().then(
        (data) => {
          //console.log(data) // successful response
          stackResponse = data;
        }
      ).catch((err) => {
        if (err) {
          console.log(err, err.stack);
          throw new Error('Error creating cloudfoundation stack');
        }
      });

      if (!stackResponse) {
        throw new Error('Error creating cloudfoundation stack');
      }

      stackStatusPolling.push(
        new Promise((resolve) => {

          async function checkStackStatus(name, entry) {

            await cloudformation.describeStacks({ StackName: name }).promise().then(
              async (data) => {

                if (data && data.Stacks) {
                  const stack = data.Stacks[0];
                  const stackStatus = stack.StackStatus;
                  //console.log('stack',JSON.stringify(stack))
                  //console.log('data',JSON.stringify(data))

                  if (AWS_STACK_STATUS_COMPLETE_CODES.indexOf(stackStatus) > -1) {
                    const success = stackStatus === 'CREATE_COMPLETE';

                    if (success) {

                      let { host, env } = await createPlutoraEnvironment(stack, entry);
                      //let target = await createOctopusDeploymentTarget(stack);

                      await updatePlutoraTebr(stack, entry, true, env, host);
                    } else {

                      await updatePlutoraTebr(stack, entry, false);
                    }
                    resolve()
                  } else {
                    setTimeout(async () => {
                      await checkStackStatus(name, entry);
                    }, TASK_POLLING_FREQUENCY_MS);
                  }
                } else {
                  throw new Error('Error checking stack status');
                }
              }
            ).catch((err) => {
              if (err) {
                console.log(err, err.stack);
                throw new Error('Error checking stack status');
              }
            })
          }

          checkStackStatus(stackname, entry);
        })
      );

    });

    async function createPlutoraEnvironment(stackInfo, entry) {
      const success = stackInfo.StackStatus === 'CREATE_COMPLETE';

      //const systemId = entry.additionalInfo.find((i) => i.name == 'System Id');
      //const hostname = stackInfo.Outputs.find((i) => i.OutputKey === 'Host');
      const hostname = stackInfo.StackId;

      //console.log('hostname', hostname)
      //console.log('stackname', JSON.stringify(stackInfo))

      const env = await plutora.plutoraRequest(
        plutoraAccessToken,
        'POST',
        'environments',
        JSON.stringify({
          name: `AWS Cloudformation Stack: ${stackInfo.StackName}`,
          title: `AWS Cloudformation Stack: ${stackInfo.StackName}`,
          vendor: 'Plutora',
          StatusId: '05d7f8d0-d320-e811-a980-fc49c3e38ffc',        // active
          Status: 'Active',
          linkedSystemId: '8e08fcd3-5551-e811-a981-ee34a4e98dd2',  // todo make dynamic
          usageWorkItemId: '31409840-0e20-e811-a980-fc49c3e38ffc', // todo: make dynamic. Lookup fields?   https://usapi.plutora.com/swagger/ui/index#!/LookupFields/LookupFields_GetLookupFieldByType
          environmentStatusId: success ? PLUTORA_ENVIRONMENT_STATUS_ACTIVE : PLUTORA_ENVIRONMENT_STATUS_DECOMMISIONED,
          isSharedEnvironment: false,
          color: '#9F56B3'
        }),
      );
      //console.log('environment', JSON.stringify(env))

      const host = await plutora.plutoraRequest(
        plutoraAccessToken,
        'POST',
        'Hosts',
        JSON.stringify({
          name: hostname,
          environmentId: env.id
        })
      );
      //console.log('host', JSON.stringify(host))

      const layer = await plutora.plutoraRequest(
        plutoraAccessToken,
        'POST',
        'Layers',
        JSON.stringify({
          componentName: `#{package-id}`,
          hostId: host.id,
          environmentId: env.id,
          stackLayerID: PLUTORA_STACK_LAYER_ID_APPLICATION
        })
      );
      //console.log('layer', JSON.stringify(layer))

      return {
        env,
        host,
        layer
      }
    }

    async function updatePlutoraTebr(stackInfo, entry, success, env, host) {
      // fetch tecr for environment id (there is more info provided when getting 1)
      const fullTebr = await plutora.plutoraRequest(
        plutoraAccessToken,
        'GET',
        `TEBRs/${entry.tebr.id}`
      )
      //console.log(JSON.stringify(fullTebr));

      let description;
      if (success) {
        // TODO: don't do this in the description. but plutora API is missing functionality
        description = JSON.stringify({
          "StackName": `${stackInfo.StackName}`,
          "Environment": `${env.name}`,
          "Host": `${host.name}`
        });
      } else {
        description = '';
      }

      // update tebr
      const updateStatus = await plutora.plutoraRequest(
        plutoraAccessToken,
        'PUT',
        `TEBRs/${entry.tebr.id}`,
        JSON.stringify({
          ...fullTebr,
          description,
          status: success ? 'Completed' : 'Failed',
          statusID: success ? PLUTORA_TEBR_COMPLETED : PLUTORA_TEBR_FAILED
        }),
      )
      console.log('tebr', JSON.stringify(updateStatus));
    }

    await Promise.all(stackStatusPolling);

  } catch (err) {
    console.log(err)
    throw err
  }
}

module.exports = {
  run: run,
}

// run({
//   arguments: {
//     octopusAPIURL: 'plutora.octopus.app',
//     octopusAPIKey: 'API-LQ6PERPIKE2UDGWXIGQRDXQDW',
//     accessKeyId: 'AKIAJVPCGIFLLY243RNA',
//     secretAccessKey: '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',
//     oauthUrl: 'usoauth.plutora.com',
//     clientId: 'KFUMNTJWIJSEBHDB3GSG2C2IAY',
//     clientSecret: 'NFCR3SMOUPFURDVGRWFQT5PZXM',
//     username: 'mike.bradford@verys.com',
//     password: 'V3rys2016!',
//     apiUrl: 'usapi.plutora.com'
//   }
// })
