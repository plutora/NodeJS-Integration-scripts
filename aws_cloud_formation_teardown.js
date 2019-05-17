const AWS = require('aws-sdk')
const https = require('https')
const querystring = require('querystring')

const TASK_POLLING_FREQUENCY_MS = 5000;
const AWS_STACK_STATUS_COMPLETE_CODES = ['CREATE_COMPLETE', 'CREATE_FAILED', 'ROLLBACK_COMPLETE', 'ROLLBACK_FAILED'];

//TODO get these from the lookups endpoint
const PLUTORA_TEBR_STATUS_ID_FAILED = '2679af0a-a376-e911-a982-f2cb536a8f94';
const PLUTORA_TEBR_STATUS_ID_ENDED = '8ec5cb9d-d420-e811-a980-fc49c3e38ffc';

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
      !args.arguments.region ||
      !args.arguments.clientId ||
      !args.arguments.clientSecret ||
      !args.arguments.username ||
      !args.arguments.password ||
      !args.arguments.apiUrl ||
      !args.arguments.oauthUrl
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
        console.log('options', JSON.stringify(options))
        res.setEncoding('utf8')
        res.on('data', function(chunk) {
          // console.log(chunk)
          body += chunk
        })
        res.on('end', function() {
          console.log(body)
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
              console.log(e)
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
    region: config.aws.region
  })

  const cloudformation = new AWS.CloudFormation()

  console.log('AWS configured!')
  console.log(JSON.stringify(cloudformation))

  try {
    let plutoraAccessToken = await plutora.plutoraGetAccessToken()
    //console.log('Got Plutora Access Token...', plutoraAccessToken)

    // fetch TEBRs
    const tebrs = await plutora.plutoraRequest(plutoraAccessToken, 'GET', 'TEBRs')

    if (!tebrs || !tebrs.length) {
      throw new Error('could not fetch TEBRs')
    }

    // filter by status + type + end date
    var filtered = tebrs.filter(
      resp => {
        let isEnded = new Date(resp.endDate) < new Date();
        return isEnded && resp.status === 'Completed' && resp.type === 'AWS Environment';
      },
    )

    if (!filtered || !filtered.length) {
      throw new Error('no TEBRs found with Status = "Completed" & Type = "AWS Environment"')
    }

    // fetch additional info
    const description = {};
    await Promise.all(
      filtered.map(obj =>
        plutora.plutoraRequest(plutoraAccessToken, 'GET', `TEBRs/${obj.id}`).then((f) => {
          description[obj.id] = {
            stackinfo: f,
            id: obj.id
          };
        }),
      ),
    )
    //console.log("stackinfo", JSON.stringify(description))

    const stackStatusPolling = [];

    await Object.keys(description).forEachAsync(async (tebrID) => {
      const entry = description[tebrID].stackinfo;
      console.log(`Processing TEBR:`, entry.id);
      var StackName = null;

      // TODO: dont do this with description field. unable to update environment name in create script.  using description for now instead.
      try {
        let info = JSON.parse(entry.description);
        StackName = info.StackName;
      } catch {
        console.log('unable to find stackname:' + entry.description);
      }

      const id = StackName.replace('Plutora-','')
      const params = {
        StackName: StackName /* required */
      }

      if (StackName) {
        console.log(`Tearing down ${StackName}`)
        
        stackStatusPolling.push(new Promise( async (resolve) => {
          await cloudformation.deleteStack(params,
            async (err, data) => {
              if (err) {
                // failure
                console.log("Error: ",JSON.stringify(err))
                console.log(`Failure: teardown of ${StackName}`)
                await updatePlutoraTebr(entry, false)
              } else {
                console.log(`Success: teardown of ${StackName}`)
                console.log(JSON.stringify(data))
                await updatePlutoraTebr(entry, true)
              }
              resolve();
            }
          )
        }))
      } else {
        console.log(`Unable to teardown ${entry.id} because there is no stack name.`)
      }
    });

    async function updatePlutoraTebr(entry, success) {
      // fetch tecr for environment id (there is more info provided when getting 1)
      const fullTebr = await plutora.plutoraRequest(
        plutoraAccessToken,
        'GET',
        `TEBRs/${entry.id}`
      )
      const updateStatus = await plutora.plutoraRequest(
        plutoraAccessToken,
        'PUT',
        `TEBRs/${entry.id}`,
        JSON.stringify({
          ...fullTebr,
          status: success ? 'Completed' : 'Failed',
          statusID: success ? PLUTORA_TEBR_STATUS_ID_ENDED : PLUTORA_TEBR_STATUS_ID_FAILED
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
