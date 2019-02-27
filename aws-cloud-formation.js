const AWS = require('aws-sdk')
const https = require('https')
const querystring = require('querystring')

function guid() {
  function s4() {
    return Math.floor((1 + Math.random()) * 0x10000)
      .toString(16)
      .substring(1)
  }

  return `${s4()}-${s4()}-${s4()}`
}

/////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////Config//////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////////

var config = {
  plutora: {
    oauthUrl: 'usoauth.plutora.com',
    clientId: 'KFUMNTJWIJSEBHDB3GSG2C2IAY',
    clientSecret: 'NFCR3SMOUPFURDVGRWFQT5PZXM',
    username: 'charlie.mantle@verys.com',
    password: 'V3rys2016!',
    apiUrl: 'usapi.plutora.com',
  },
}

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
        console.log('options', options)
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
  //configuring the AWS environment
  AWS.config.update({
    accessKeyId: args.arguments.accessKeyId,
    secretAccessKey: args.arguments.secretAccessKey,
    region: 'eu-west-2',
  })

  const cloudformation = new AWS.CloudFormation()

  console.log('AWS configured!')

  try {
    let plutoraAccessToken = await plutora.plutoraGetAccessToken()
    console.log('Got Plutora Access Token...', plutoraAccessToken)

    const data = await plutora.plutoraRequest(plutoraAccessToken, 'GET', 'TEBRs')

    const filtered = data.filter(
      resp => resp.status === 'Approved' && resp.type === 'AWS Environment',
    )

    const promiseArr = await Promise.all(
      filtered.map(obj =>
        plutora.plutoraRequest(plutoraAccessToken, 'GET', `TEBRs/${obj.id}/additionalInformation`),
      ),
    )

    const template = promiseArr[0].filter(t => t.name === 'Template Tag')

    const id = guid()
    const stackname = `Plutora-${id}`
    const params = {
      StackName: stackname /* required */,
      Tags: [
        {
          Key: `foo-${id}` /* required */,
          Value: `bar-${id}` /* required */,
        },
      ],
      TemplateBody: template[0].text,
    }

    console.log('creating cloudformation template...')
    const test = await cloudformation
      .createStack(params, function(err, data) {
        if (err) {
          console.log(err, err.stack)
          return
        }
        // an error occurred
        console.log(data) // successful response
      })
      .promise()

    console.log('creating env...')
    const env = await plutora.plutoraRequest(
      plutoraAccessToken,
      'POST',
      'environments',
      JSON.stringify({
        name: stackname,
        vendor: 'SAP',
        linkedSystemId: '7ae4190b-cf2f-e911-a983-fee0ec43c416',
        usageWorkItemId: 'c3b02529-43b5-e811-a983-fee0ec43c416',
        environmentStatusId: 'bdb02529-43b5-e811-a983-fee0ec43c416',
        isSharedEnvironment: false,
        color: '#9F56B3',
        title: stackname,
      }),
    )
    console.log('env', JSON.stringify(env))
  } catch (err) {
    console.log('Error', err, err.message, err.stack)
  }
}

module.exports = {
  run: run,
}

// run(process.argv)
