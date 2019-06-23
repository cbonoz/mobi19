"use strict"
// Server code for vocal project.
// License: Apache License 2.0

const axios = require("axios")
const express = require("express")
const cors = require("cors")
const bodyParser = require("body-parser")
const http = require("http")
const https = require("https")
const pg = require("pg")
const path = require("path")
const admin = require("firebase-admin")

const serviceAccount = require("./db/vocalfb.json")
const async = require("async")

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://vocalcoin-69799.firebaseio.com"
})

// Passport for middleware HTTP bearer authentication strategy for the blockchain routes
const passport = require("passport")
const Strategy = require("passport-http-bearer").Strategy
const db = require("./db")

const requirePostgres = true
const PORT = 9007

passport.use(
  new Strategy(function(token, cb) {
    db.users.findByToken(token, function(err, user) {
      if (err) {
        return cb(err)
      }
      if (!user) {
        return cb(null, false)
      }
      return cb(null, user)
    })
  })
)

// Variable and Server Setup //

// custom libraries.
const vocal = require("./vocal")

const dbUser = process.env.ADMIN_DB_USER
const dbPass = process.env.ADMIN_DB_PASS
const dbName = "vocal"
const connectionString =
  process.env.VOCAL_DATABASE_URL ||
  `postgres://${dbUser}:${dbPass}@localhost:5432/${dbName}`
console.log("connectionString", connectionString)

const pool = new pg.Pool({
  connectionString: connectionString
})

const app = express()
const server = require("http").createServer(app)
const io = require("socket.io")(server, { origins: "*:*" })

app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: true }))

// TODO: use reduced cors in production.
// const whitelist = ['https://vocalcoins.com', 'https://www.vocalcoins.com'];
// app.use(cors({ origin: whitelist }));

app.use(cors())

pool.on("error", (err, client) => {
  console.error("Unexpected error on idle client", err)
  process.exit(-1)
})

app.get("/api/hello", (req, res) => {
  return res.json("hello world")
})

function getUserAndExecute(userId, cb) {
  const query = vocal.getUserQuery(userId)
  pool.query(query, (err, result) => {
    if (err) {
      console.error("getUser error", err)
      throw new Error(err)
    }

    console.log("getUser success", result)

    const rows = result.rows
    const user = rows[0]
    cb(user)
  })
}

function getAddressAndExecute(userId, cb) {
  const query = vocal.getAddress(userId)
  pool.query(query, (err, result) => {
    if (err || !result.rows) {
      console.error("vocal address error", err)
      throw new Error(err)
    }
    const address = result.rows[0]["address"]
    console.log("got address", addreess)
    cb(address)
  })
}

function getBalanceAndExecute(userId, cb) {
  const query = vocal.getBalance(userId)
  pool.query(query, (err, result) => {
    console.log("getbalance", query, err, result)
    if (err) {
      console.error("getbalance error", err)
      throw new Error(err)
    }

    const rows = result.rows
    if (rows) {
      let balance = rows[0]["balance"]
      console.log("balance", userId, balance)
      if (!balance) {
        console.log("null balance, using default", vocal.DEFAULT_BALANCE)
        balance = vocal.DEFAULT_BALANCE
      }
      cb(balance)
      return
    }
    cb(0)
  })
}

// Sends or Pulls money between the specified userId and the master Vocal (issuer) account.
function modifyBalanceAndExecute(userId, amount, cb) {
  const query = vocal.modifyBalance(userId, amount)
  pool.query(query, (err, result) => {
    console.log("modify balance", query, err, result)
    if (err) {
      console.error("modify balance error", err)
      throw new Error(err)
    }
    // Successfully modified balance. Proceed.
    cb()
  })
}

/* Map endpoints */

app.post("/api/issues/region", (req, res) => {
  const body = req.body
  const lat1 = body.lat1
  const lat2 = body.lat2
  const lng1 = body.lng1
  const lng2 = body.lng2

  const query = vocal.getIssuesForRegionQuery(lat1, lng1, lat2, lng2)

  pool.query(query, (err, result) => {
    console.log("issues", err, result)
    if (err) {
      console.error("issues", err)
      return res.status(500).json(err)
    }
    // Return the rows that lie within the bounds of the map view.
    return res.json(result.rows)
  })
})

app.post(
  "/api/vote",
  passport.authenticate("bearer", {
    session: false
  }),
  (req, res) => {
    const body = req.body
    const vote = JSON.parse(body.vote)

    const userId = vote.userId
    const issueId = vote.issueId

    const checkVoteQuery = vocal.checkVoteQuery(userId, issueId)
    pool.query(checkVoteQuery, (err, result) => {
      console.log("check vote", checkVoteQuery)
      console.log("checkVote", err, result)
      if (err) {
        console.error("postVote error", err)
        return res.status(500).json(err)
      }

      if (result.rows.length > 0) {
        // if we already have a vote for this user and issue, return.
        const errorMessage = "user already voted on this issue"
        console.error(errorMessage)
        return res.status(401).json({ data: errorMessage })
      }

      const amount = vocal.calculateVocalCredit(userId)
      // Credit the user.
      modifyBalanceAndExecute(userId, amount, () => {
        // Now add the vote.
        const voteQuery = vocal.insertVoteQuery(vote)
        pool.query(voteQuery, (err, result) => {
          console.log("postVote", err, result)
          if (err) {
            console.error("postVote error", err)
            return res.status(500).json(err)
          }
          // pool.end()
          return res.json(result.rows)
        })
      })
    })
  }
)

app.post(
  "/api/issue",
  passport.authenticate("bearer", {
    session: false
  }),
  (req, res) => {
    const body = req.body
    const issue = JSON.parse(body.issue)
    const userId = issue.userId
    try {
      getBalanceAndExecute(userId, balanceFromBlockchain => {
        // const balanceFromBlockchain = contract.getBalance(address);
        const balance = parseFloat(balanceFromBlockchain["balance"])
        if (balance < vocal.ISSUE_COST) {
          const errorMessage = `Insufficient balance (${balance}), require ${
            vocal.ISSUE_COST
          }`
          return res.status(401).json(new Error(errorMessage))
        }

        modifyBalanceAndExecute(userId, -vocal.ISSUE_COST, () => {
          // Insert the new issue after the deduction made.
          const query = vocal.insertIssueQuery(issue)
          pool.query(query, (err, result) => {
            if (err) {
              console.error("postIssue error", err)
              // TODO: reverse the balance modification should the deduction succeed, but insert issue fail.
              return res.status(500).json(new Error(err))
            }
            console.log("postIssue success", result)
            // pool.end()
            return res.json(result.rows)
          })
        })
      })
    } catch (e) {
      return res.status(500).json(new Error(e))
    }
  }
)

app.post(
  "/api/issue/delete",
  passport.authenticate("bearer", {
    session: false
  }),
  (req, res) => {
    const body = req.body
    const userId = body.userId
    const issueId = body.issueId

    const query = vocal.deleteIssueQuery(userId, issueId)

    pool.query(query, (err, result) => {
      if (err) {
        console.error("delete issue error", err)
        return res.status(500).json(err)
      }

      console.log("delete issue success", result)
      return res.json(result.rows)
    })
  }
)

/* Dashboard routes */

app.get(
  "/api/issues/:userId",
  passport.authenticate("bearer", {
    session: false
  }),
  (req, res) => {
    const userId = req.params.userId
    const query = vocal.getIssuesForUserQuery(userId)
    pool.query(query, (err, result) => {
      if (err) {
        console.error("getIssues error", err)
        return res.status(500).json(err)
      }

      console.log("getIssues success", result)
      // pool.end()
      return res.json(result.rows)
    })
  }
)

app.get(
  "/api/hasvoted/:userId/:issueId",
  passport.authenticate("bearer", {
    session: false
  }),
  (req, res) => {
    const userId = req.params.userId
    const issueId = req.params.issueId
    const checkVoteQuery = vocal.checkVoteQuery(userId, issueId)
    pool.query(checkVoteQuery, (err, result) => {
      if (err) {
        console.error("postVote error", err)
        return res.status(500).json(err)
      }

      console.error("postVote success", checkVoteQuery, result)
      const rows = result.rows
      return res.json(rows.length > 0)
    })
  }
)

app.get(
  "/api/votes/:issueId",
  passport.authenticate("bearer", {
    session: false
  }),
  (req, res) => {
    const issueId = req.params.issueId
    const query = vocal.getVotesForIssueIdQuery(issueId)

    pool.query(query, (err, result) => {
      if (err) {
        console.error("getVotes error", err)
        return res.status(500).json(err)
      }
      console.log("getVotes success", result)
      // pool.end()
      return res.json(result.rows)
    })
  }
)

app.post("/api/signin", (req, res) => {
  const body = req.body
  console.log(body)
  const userId = body.userId
  const email = body.email
  const username = body.username

  try {
    // Look up the user.
    const query = vocal.getUserQuery(userId)
    pool.query(query, (err1, result) => {
      if (err1) {
        console.error("getUser error", err1)
        throw new Error(err1)
      }

      console.log("getUser success", result)

      const rows = result.rows

      if (
        rows instanceof Array &&
        rows.length &&
        rows[0] &&
        rows[0]["address"]
      ) {
        const user = rows[0]
        // User already created with address.
        console.log("found user", user)
        const address = user["address"]

        // Return the auth token after the user is confirmed.
        admin
          .auth()
          .createCustomToken(userId)
          .then(customToken => {
            // Send token back to client.
            console.log(userId, customToken)
            db.users.assignToken(userId, customToken)
            return res.json({
              token: customToken,
              address: address
            })
          })
          .catch(error => {
            console.error("Error creating custom token:", error)
            throw new Error(error)
          })
      } else {
        // User does not exist
        const seed = neolib.createPrivateKey()
        const keypair = neolib.createKeyPair(seed)
        const publicKey = keypair.publicKey
        const address = keypair.address

        const encSeed = neolib.encryptKey(seed)

        // TODO: Create account on the blockchain, then create a user record in the Vocal DB.
        const userQuery = vocal.insertUserQuery(
          userId,
          email,
          address,
          encSeed,
          username,
          publicKey,
          vocal.DEFAULT_BALANCE
        )
        console.log("createNewUser", address, seed, publicKey)
        pool.query(userQuery, (err, result) => {
          if (err) {
            const errorMessage = JSON.stringify(err)
            console.error("createNewUser error", errorMessage)
            throw new Error(errorMessage)
          }
          console.log(
            "createNewUser success",
            userQuery,
            JSON.stringify(result)
          )

          // Return the auth/session token after the Vocal DB user is successfully created.
          admin
            .auth()
            .createCustomToken(userId)
            .then(customToken => {
              // Send token back to client.
              console.log(userId, customToken)
              db.users.assignToken(userId, customToken)
              return res.json({
                token: customToken,
                address: address
              })
            })
            .catch(error => {
              error = JSON.stringify(error)
              console.error("Error creating custom token:", error)
              throw new Error(error)
            })
        })
      }
    })
  } catch (e) {
    return res.status(500).json(new Error(e))
  }
})

/* Query methods */

app.get(
  "/api/balance/:userId",
  passport.authenticate("bearer", {
    session: false
  }),
  (req, res) => {
    const userId = req.params.userId
    try {
      getUserAndExecute(userId, user => {
        const address = user.address
        const balance = user.balance
        res.json({ address: address, balance: balance })
      })
    } catch (err) {
      console.error(err)
      return res.json(err)
    }
  }
)

app.get(
  "/api/address/:userId",
  passport.authenticate("bearer", {
    session: false
  }),
  (req, res) => {
    const userId = req.params.userId
    try {
      getAddressAndExecute(userId, address => {
        return res.json(address)
      })
    } catch (err) {
      return res.status(500).json(err)
    }
  }
)

// DB Connection and Server start //

pool.connect((err, client, done) => {
  if (err) {
    console.error("postgres connection error", err)
    if (requirePostgres) {
      console.error("exiting")
      return
    }
    console.error("continuing with disabled postgres db")
  }

  server.listen(PORT, () => {
    console.log("Express server listening on localhost port: " + PORT)
  })
})
