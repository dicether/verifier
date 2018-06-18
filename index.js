const axios = require("axios");
const fs = require("fs");
const Web3 = require("web3");
const stateChannel = require("@dicether/state-channel");

// addresses of our different contracts
const CONTRACT_ADDRESS2 = "0xbF8B9092e809DE87932B28ffaa00D520b04359aA";
const CONTRACT_ADDRESS3 = "0x3e07881993c7542a6Da9025550B54331474b21dd";
const CONTRACT_ADDRESS4 = "0xEB6F4eC38A347110941E86e691c2ca03e271dF3b";

// address of the house game session signer
const SERVER_ADDRESS = "0xCef260a5Fed7A896BBE07b933B3A5c17aEC094D8";

const NEW_EIP_GAME_ID = 572;
const OLD_EIP_GAME_ID = 638;

// we are on the main chain => chain id 1
const CHAIN_ID = 1;

// base URL of our api
axios.defaults.baseURL = "https://api.dicether.com/api";

// our contract abi
const GameChannelAbi = JSON.parse(fs.readFileSync(__dirname + "/GameChannelContract.json", "utf8"));


// returns the contract address for the given game id.
function getContractAddress(gameId) {
    if (gameId < 256) {
        throw new Error("Verification not supported for games below game id 256!");
    } else if (gameId < 572) {
        return CONTRACT_ADDRESS2;
    } else if (gameId < 638) {
        return CONTRACT_ADDRESS3;
    } else {
        return CONTRACT_ADDRESS4;
    }
}


// return the signature version for the given game id.
function getSignatureVersion(gameId) {
    return gameId < NEW_EIP_GAME_ID || gameId >= OLD_EIP_GAME_ID ? 1 : 2;
}


// loads game date information from the smart contract.
function getGameData(web3, contract, gameId) {
    let serverEndHash;
    let userEndHash;

    return contract.getPastEvents('LogGameCreated', {
            filter: {gameId: gameId},
            fromBlock: 0,
            toBlock: 'latest'
    }).then(function(events) {
        const len = events.length;
        if (len !==1 || Number.parseInt(events[0].returnValues.gameId) !== gameId) {
            return Promise.reject(new Error("Could not read game info (LogGameCreatedEvent)!"));
        }

        userEndHash = events[0].returnValues.playerEndHash;
        serverEndHash = events[0].returnValues.serverEndHash;

        return contract.getPastEvents('LogGameEnded', {
            filter: {gameId: gameId},
            fromBlock: 0,
            toBlock: 'latest'
        });
    }).then(function(events) {
        const len = events.length;
        if (len !==1 || Number.parseInt(events[0].returnValues.gameId) !== gameId) {
            return Promise.reject(new Error("Could not read game info (LogGameEndedEvent)!"));
        }

        const returnValues = events[0].returnValues;

        return {
            roundId: Number.parseInt(returnValues.roundId),
            balance: Number.parseInt(returnValues.balance) / 1e9, // we use gwei as base unit
            serverEndHash: serverEndHash,
            userEndHash: userEndHash,
            regularEnded: Number.parseInt(returnValues.reason) === 0
        }
    });
}


// verify every bet of the game session.
// we can verify if the bet result is correct.
// we can verify if the balance after the bet is correct.
// we can verify if the final payout is correct.
function verifyBets(gameId, bets, roundId, balance, serverEndHash, userEndHash, regularEnded) {
    const version = getSignatureVersion(gameId);
    const numBets = roundId - (regularEnded ? 1 : 0);

    if (bets.length !== numBets) {
        throw Error("Invalid number of bets! Expected: " + bets.length + " Got: " + numBets);
    }

    // reverse so first placed bet is bets[0]
    bets = bets.reverse();

    const firstBet = bets[0];

    // check if hash chains are correct
    if (serverEndHash !== firstBet.serverHash) {
        throw Error("Invalid first bet serverHash");
    }
    if (userEndHash !== firstBet.userHash) {
        throw Error("Invalid first bet user Hash");
    }

    let userPrevHash;
    let serverPrevHash;
    let prevBalance = 0;

    // check every bet of the game session
    for (let i = 0; i < bets.length; i++) {
        const bet = bets[i];

        const contractAddress = bet.contractAddress;
        const userAddress = bet.user.address;

        const signedBetData = {
            roundId: bet.roundId,
            gameType: bet.gameType,
            num: bet.num,
            value: bet.value,
            balance: bet.balance,
            serverHash: bet.serverHash,
            userHash: bet.userHash,
            gameId: bet.gameId,
        };

        // First check if player and server signatures are valid
        if (!stateChannel.verifySignature(signedBetData, CHAIN_ID, contractAddress, bet.serverSig, SERVER_ADDRESS, version)) {
            throw Error("Invalid server signature for bet with roundId: " + bet.roundId);
        }

        if (!stateChannel.verifySignature(signedBetData, CHAIN_ID, contractAddress, bet.userSig, userAddress, version)) {
            throw Error("Invalid player signature for bet with roundId: " + bet.roundId);
        }

        // Now check if seeds are valid
        if (stateChannel.keccak(bet.userSeed) !== bet.userHash) {
            throw Error("Invalid user seed for bet with roundId: " + bet.roundId);
        }

        if (stateChannel.keccak(bet.serverSeed) !== bet.serverHash) {
            throw Error("Invalid server seed for bet with roundId: " + bet.roundId);
        }

        // check if hash chain is valid
        if (i !== 0) {
            if (stateChannel.keccak(bet.userHash) !== userPrevHash) {
                throw Error("Invalid hash chain!");
            }

            if (stateChannel.keccak(bet.serverHash) !== serverPrevHash) {
                throw Error("Invalid hash chain!");
            }

        }

        userPrevHash = bet.userHash;
        serverPrevHash = bet.serverHash;

        // check if result number is valid
        const resultNumShouldBe = stateChannel.calcResultNumber(bet.gameType, bet.serverSeed, bet.userSeed);
        if (bet.resultNum !== resultNumShouldBe) {
            throw Error("Invalid number " + bet.resultNum + " instead of" + resultNumShouldBe);
        }

        // check if bet.balance is valid
        if (bet.balance !== prevBalance) {
            throw Error("Invalid balance " + bet.balance + " instead of " + balance);
        }

        // calculate balance after bet
        prevBalance = stateChannel.calcNewBalance(bet.gameType, bet.num, bet.value, bet.serverSeed, bet.userSeed, prevBalance);
    }

    // check if final balance is valid
    if (balance !== prevBalance) {
        throw Error("Invalid game session balance " + prevBalance + " instead of " + balance);
    }

    return true;
}


// verify the game session for the given gameId
function verifyGameSession(gameId) {
    // check if web3 is available
    if (window.web3 === undefined) {
        throw Error("You need a web3 enabled browser!");
    }

    // initialize web3 and the contract
    const web3 = new Web3(window.web3.currentProvider);
    const contract = new web3.eth.Contract(GameChannelAbi, getContractAddress(gameId));

    // verify bets for the given game id
    return web3.eth.net.getId().then(function(network) {
        if (Number.parseInt(network) !== CHAIN_ID) {
            throw new Error("You need to use the Main Network");
        }

        return axios.get("/bets/gameId/" + gameId);
    }).then(function(reponse) {
        const bets = reponse.data.bets;
        const gameData = getGameData(web3, contract, gameId);
        return Promise.all([bets, gameData]);
    }).then(function([bets, gameData]) {
        if (!verifyBets(gameId, bets, gameData.roundId, gameData.balance, gameData.serverEndHash, gameData.userEndHash, gameData.regularEnded)) {
            alert("Bet Validation failed!");
        } else {
            alert("All " + bets.length + " bets for game session " + gameId + " are valid!");
        }
    })
}


verifyButton.addEventListener('click', function(event) {
    document.getElementById("spinner").style.display = 'inline-block';

    const gameId = Number.parseInt(document.getElementById('gameIdInput').value);
    if (Number.isNaN(gameId)) {
        alert("Could not parse gameId");
        return;
    }

    try {
        verifyGameSession(gameId).then(function() {
            document.getElementById("spinner").style.display = 'none';
        }).catch(function (error) {
            alert("Could not verify game session with id: " + gameId + ": " + error);
            document.getElementById("spinner").style.display = 'none';
        });
    } catch(error) {
        alert("Could not verify game session with id: " + gameId + ": " + error);
        document.getElementById("spinner").style.display = 'none';
    }
});
