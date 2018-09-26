/*
This script will connect to Jenkins using Basic Authentication and trigger the execution of a Job called 'Demo' using API' requests. 
It will then copy the log file from Jenkins to the execution log in Plutora as well as send build progress updates back to the Plutora UI

To execute this script on your own instance of Plutora you will need to replace all credentials and API end points. 
These are highlighted as comments like this: <<INSERT Text >>
*/

const https = require("https");
const http = require("http");


let run = function (args) {
    return new Promise((resolve, reject) => {
        let options = {
            host: '<<INSERT YOUR HOST URL>>',
            port: 80,
            path: '/job/Demo/lastBuild/api/json',
            method: 'GET',
            headers: {
                accept: 'application/json',
                authorization: '<<INSERT YOUR AUTHENTICATION DETAILS FOR JENKINS>>'
            }
        };

        let number = 0;

        return req(options).then((data) => {
            number = data.number + 1;
            options.path = '/job/Demo/build?token=<<INSERT BUILD TOKEN>>';
            return req(options).then(() => {
                options.path = "/job/Demo/" + number + "/api/json?tree=building,number,result,executor[progress]";
                setTimeout(function () {
                    var interval = setInterval(function () {
                        return req(options).then((data) => {
                            if (!data.building) {
                                clearInterval(interval);
                                options.path = "/job/Demo/" + number + "/consoleText";
                                return req(options).then((log) => {
                                    //Console.log will write to the Plutora execution log file
				    console.log("Build Number: " + number);
                                    console.log("Build Log: " + log);
                                    if (data.result === "SUCCESS") {
                                        return resolve();
                                    } else {
                                        return reject();
                                    }
                                }, (err) => {
                                    return reject(err);
                                });
                            }
			    //Notifier.progress will send updates back to the UI in Plutora
                            notifier.progress('Building...' + data.executor.progress + '%');
                        }, (err) => {
                            clearInterval(interval);
                            return reject(err);
                        });
                    }, 3000);
                }, 5000);
            }, (err) => {
                return reject(err);
            });
        }, (err) => {
            return reject(err);
        });
    });
};

let req = function (options) {
    return new Promise((resolve, reject) => {
        http.get(options, (resp) => {
            let data = '';
            resp.on('data', (chunk) => {
                data += chunk;
            });
            resp.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                }
                catch (error) {
                    resolve(data);
                }
            });
        }).on("error", (err) => {
            console.error("Error: " + err.message);
            reject(err.message);
        });
    });
}

module.exports = {
    run: run
};
