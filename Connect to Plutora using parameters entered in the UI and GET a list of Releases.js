/*
This script will connect to Plutora using Oauth 2.0 Authentication and retrieve a list of Releases using an API request.
It will then console.log the response to the execution log in Plutora.

This script uses credentials that are defined in Plutora UI as Job Parameters. Refer to the knowledge base in Plutora for more information on adding parameters

To execute this script on your own instance of Plutora, create a new Job, upload the script and define the 'Credentials' in the Plutora UI as parameters. 

The parameters should be named exactly as they are named in the script. For example, 'args.arguments.oauthurl' should a parameter call 'oauthurl' in the UI
*/

const https = require("https");
var querystring = require('querystring');
let apiUrl = '';

var credentials = {
    oauthurl: '',
    clientId: '',
    clientSecret: '',
    username: '',
    password: ''
}

const getBearerToken = function () {
    notifier.progress('Step 1: Starting Authorisation');
	console.log ('Step 1: Starting Authorisation');
    return new Promise(function (resolve, reject) {
        var body = "";
        var data = querystring.stringify({
            client_id: credentials.clientId,
            client_secret: credentials.clientSecret,
            grant_type: "password",
            username: credentials.username,
            password: credentials.password
        });

        var options = {
            method: "POST",
            "rejectUnauthorized": false,
            hostname: credentials.oauthurl,
            path: "/oauth/token",
            headers: {
                "Content-Type": 'x-www-form-urlencoded; charset=urf-8',
                'Accept': "application/json"
            }
        };
		notifier.progress ('Sending request...');
		console.log ('Sending request...');
        var req = https.request(options, function (res) {
            res.setEncoding('utf8');
            res.on('data', function (chunk) {
                body += chunk;
            });
            res.on('end', function () {
                result = JSON.parse(body);
                resolve(result.access_token);
				notifier.progress ('Authorisation Complete');
				console.log ('Authorisation Complete');
            });
        });
	req.write(data);
        req.end();
    })

}


const makeRequest = function (bearerToken, entity) {
    notifier.progress('Step 2: Making Request for Releases');
	console.log('Step 2: Making Request for Releases');

	return new Promise(function (resolve, reject) {
        var req = https.request({
            method: "GET",
            hostname: apiUrl,
            port: 443,
            path: "/" + entity,
            "rejectUnauthorized": false,
            headers: {
                Authorization: "bearer " + bearerToken
            }

        }, function (res) {
            let body = "";
            res.on("data", data => {
                body += data;
            });
            res.on("end", () => {
                body = JSON.parse(body);
                resolve(body);
            });
        });
		req.write("");
        req.end();
    });

}

let run = function (args) {
    
    credentials = {
		oauthurl: args.arguments.oauthurl,
		clientId: args.arguments.clientId,
		clientSecret: args.arguments.clientSecret,
		username: args.arguments.username,
		password: args.arguments.password
    }

    apiUrl = args.arguments.apiUrl;

    return new Promise(function (resolve, reject) {
        console.log('getBearerToken');
		getBearerToken()
            .then(
                function (bearerToken) {
					makeRequest(bearerToken, "Releases")
                    .then(
                        function (result) {
							console.log(JSON.stringify(result));
                            resolve('Done!');
                        })
					.catch(function (err) {
						console.error(err);
						reject(err.message);
					})
								
				}
			)

            .catch(function (err) {
                console.log(err);
                reject(err.message);
            })
    });

    return promise;
};

module.exports = {
    run: run
};

