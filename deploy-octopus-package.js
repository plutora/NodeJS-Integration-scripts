const https = require('https')
const querystring = require('querystring')

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
////////////////////////////////////Octopus Cloud API Calls///////////////////////////////
////////////////////////////////////////////////////////////////////////////////////

const octopus = {
  request: function(octopusAPIURL, octopusAPIKey, reqType, apipath, data) {
    return new Promise(function(resolve, reject) {
      let body = ''
      var req = https.request(
        {
          method: reqType, // 'GET', 'POST'
          host: octopusAPIURL,
          port: 443,
          path: '/api/' + apipath,
          rejectUnauthorized: false,
          headers: {
            'X-Octopus-ApiKey': octopusAPIKey,
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

let run = async function(args) {
  // credentials
  const octopusAPIURL = args.arguments.octopusAPIURL
  const octopusAPIKey = args.arguments.octopusAPIKey

  try {
    let plutoraAccessToken = await plutora.plutoraGetAccessToken()

    // fetch TECRs
    const tecrs = await plutora.plutoraRequest(plutoraAccessToken, 'GET', 'TECRs')

    if (!tecrs || !tecrs.length) {
      throw new Error('could not fetch TECRs')
    }

    // filter by status + type
    const filtered = tecrs.filter(
      resp => resp.crStatus === 'Approved' && resp.crType === 'Octopus Deploy',
    )

    if (!filtered || !filtered.length) {
      throw new Error('no TECRS found with Status = "Approved" & Type = "Octopus Deploy"')
    }

    // fetch additional info
    const additionalInfo = await Promise.all(
      filtered.map(obj =>
        plutora.plutoraRequest(plutoraAccessToken, 'GET', `TECRs/${obj.id}/additionalInformation`),
      ),
    )

    // todo: add support to consume multiple tecr requests

    // parse field for Octopus Project Name
    const id = (additionalInfo[0].filter(t => t.name === 'Octopus Package Name')[0] || {}).text

    // fetch project data
    const project = await octopus.request(octopusAPIURL, octopusAPIKey, 'GET', `projects/${id}`)

    // fetch channel
    const channel = await octopus.request(
      octopusAPIURL,
      octopusAPIKey,
      'GET',
      `/projects/${project.Id}/channels`,
    )

    if (!channel || !channel.Items[0] || !channel.Items[0].Id) {
      throw new Error('no channel found')
    }

    // fetch template
    const template = await octopus.request(
      octopusAPIURL,
      octopusAPIKey,
      'GET',
      `deploymentprocesses/deploymentprocess-${project.Id}/template?channel=${channel.Items[0].Id}`,
    )

    if (
      !template ||
      !template.Packages[0] ||
      !template.Packages[0].ActionName ||
      !template.Packages[0].PackageId
    ) {
      throw new Error('no template found')
    }

    console.log('template', JSON.stringify(template))

    const packageActionName = template.Packages[0].ActionName
    const packageId = template.Packages[0].PackageId

    const feedId = 'feeds-plutora' // todo: fetch this from API

    // fetch package
    const package = await octopus.request(
      octopusAPIURL,
      octopusAPIKey,
      'GET',
      `feeds/${feedId}/packages/versions?packageId=${packageId}&take=1`,
    )

    if (!package || !package.Items[0] || !package.Items[0].Version) {
      throw new Error('no package found')
    }

    const packageVersion = package.Items[0].Version

    // fetch previous releases
    const prevReleases = await octopus.request(
      octopusAPIURL,
      octopusAPIKey,
      'GET',
      `projects/${project.Id}/releases`,
    )

    const prevReleasedPackageVersion = prevReleases.Items[0].Version

    let release = prevReleases.Items[0] // previous release

    // create a new release if there is a new package version
    // otherwise use the previous release as nothing has changed
    if (packageVersion !== prevReleasedPackageVersion) {
      console.log('should not be here.....')
      release = await octopus.request(
        octopusAPIURL,
        octopusAPIKey,
        'POST',
        'releases',
        JSON.stringify({
          ProjectId: project.Id,
          ChannelId: channel.Items[0].Id,
          Version: '1.0.i', // i = a mask to auto increment
          SelectedPackages: [{ ActionName: packageActionName, Version: packageVersion }],
        }),
      )
    }

    // fetch deploy template
    const deployTemplate = await octopus.request(
      octopusAPIURL,
      octopusAPIKey,
      'GET',
      `releases/${release.Id}/deployments/template`,
    )

    // deploy application
    const deploy = await octopus.request(
      octopusAPIURL,
      octopusAPIKey,
      'POST',
      'deployments',
      JSON.stringify({
        ...deployTemplate,
        ReleaseId: release.Id,
        EnvironmentId: deployTemplate.PromoteTo[0].Id,
      }),
    )

    // todo: wait for application to be deployed and pass data back to TECR instead of optimistically continuing

    console.log('deploy', JSON.stringify(deploy))

    const tecrID = filtered[0].id

    // update TECR status
    const updateStatus = await plutora.plutoraRequest(
      plutoraAccessToken,
      'PUT',
      `TECRs/${tecrID}`,
      JSON.stringify({
        ...filtered[0],
        crStatus: 'Completed',
        crStatusId: 'c8b02529-43b5-e811-a983-fee0ec43c416', // todo: make dynamic
        userId: 'b85178e5-532e-e911-a983-fee0ec43c416', // todo: make dynamic
      }),
    )
    console.log('updateStatus', JSON.stringify(updateStatus))

    // fetch layer
    const layer = await plutora.plutoraRequest(
      plutoraAccessToken,
      'GET',
      `Layers/330a6e32-f532-e911-a983-fee0ec43c416`, // todo: make dynamic
    )
    console.log('layer', JSON.stringify(layer))

    // fetch host
    const host = await plutora.plutoraRequest(plutoraAccessToken, 'GET', `Hosts/${layer.hostID}`)

    console.log('host', JSON.stringify(host))

    if (!host) {
      throw new Error('failed to fetch host')
    }

    // update host name
    const updateHostName = await plutora.plutoraRequest(
      plutoraAccessToken,
      'PUT',
      `Hosts/${layer.hostID}`,
      JSON.stringify({
        ...host,
        name: 'http://ec2-3-8-118-67.eu-west-2.compute.amazonaws.com/',
        // todo: make dynamic - /api/environments/{id}/machines
        // - https://verys.octopus.app/swaggerui/index.html#/Environments/CustomQueryResponseDescriptor_Octopus_Server_Web_Api_Actions_EnvironmentsMachinesResponder_
      }),
    )

    console.log('updateHostName', JSON.stringify(updateHostName))

    // update component version
    const updateVersion = await plutora.plutoraRequest(
      plutoraAccessToken,
      'PUT',
      `Layers/330a6e32-f532-e911-a983-fee0ec43c416`, // todo: make dynamic
      JSON.stringify({
        ...layer,
        componentName: template.Packages[0].PackageId,
        version:
          packageVersion !== prevReleasedPackageVersion
            ? packageVersion
            : prevReleasedPackageVersion,
      }),
    )

    console.log('updateVersion', JSON.stringify(updateVersion))
  } catch (err) {
    console.log(err)
    throw err
  }
}

module.exports = {
  run: run,
}

// run(process.argv)
