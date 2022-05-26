const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const mailgun = require("mailgun-js");
require("dotenv").config();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.qiwh1.mongodb.net/myFirstDatabase?retryWrites=true&w=majority`;

const client = new MongoClient(uri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverApi: ServerApiVersion.v1,
});

const servicesCollection = client.db("client").collection("services");
const bookingCollection = client.db("doctor").collection("bookings");
const userCollection = client.db("doctor").collection("users");
const doctorsCollection = client.db("doctor").collection("addedDoctors");

/*------- Email -------- */
const emailClient = mailgun({
  apiKey: process.env.EMAIL_SENDER_API,
  domain: process.env.EMAIL_SENDER_DOMAIN,
});

const sentEmail = (data) => {
  const { to, subject, text, html } = data;
  const mailData = {
    from: "Doctor's portal <doctorportal@dental.com>",
    to: to,
    subject: subject,
    text: text,
    html,
  };

  emailClient.messages().send(mailData, (err, body) => {
    if (err) {
      console.log(err);
    }
    console.log(body);
  });
};

/*------- Email -------- */

app.use(express.json());
const corsConfig = {
  origin: true,
  credentials: true,
};
app.use(cors(corsConfig));
app.options("*", cors(corsConfig));

app.get("/", (req, res) => {
  res.send({ message: "Server Connected" });
});

const run = async () => {
  await client.connect();

  const verifyJWT = (req, res, next) => {
    const clientToken = req.headers.authorization;
    const requrestedUserEmail = req.query.email;
    if (!clientToken) {
      return res
        .status(401)
        .send({ success: false, message: "Unauthorized Access" });
    }

    const token = clientToken.split(" ")[1];
    jwt.verify(token, process.env.ACCESS_TOKEN, (err, decoded) => {
      if (err) {
        return res
          .status(403)
          .send({ success: false, message: "Forbidden Access" });
      }
      if (requrestedUserEmail !== decoded.email) {
        return res
          .status(401)
          .send({ success: false, message: "Unauthorized Access" });
      }
      req.decoded = decoded;
      next();
    });
  };

  const verifyAdmin = async (req, res, next) => {
    const authorizedUserEmail = req.decoded.email;
    const authorizedUser = await userCollection.findOne({
      email: authorizedUserEmail,
    });
    if (authorizedUser?.role !== "admin") {
      return res.send({ message: "You are not admin" });
    }
    next();
  };

  const getAllServices = async () => {
    const cursor = servicesCollection.find({});
    const result = await cursor.toArray();
    return result;
  };

  const getAvailableServices = async (date) => {
    // get all services
    const services = await servicesCollection.find().toArray();

    // get all the booking for perticular date
    const bookingOnDate = await bookingCollection
      .find({ bookingDate: date })
      .toArray();

    // check all services if for available booking
    services.forEach((service) => {
      // get all booked services on this date that match with service name
      const bookedServices = bookingOnDate.filter(
        (booked) => booked.service === service.name
      );

      // get all booked slots
      const bookedSlots = bookedServices.map((booked) => booked.timeSlot);

      // get all slots that are not booked
      const availableSlots = service.slots.filter(
        (slot) => !bookedSlots.includes(slot)
      );
      service.availableSlots = availableSlots;
    });

    return services;
  };

  app.get("/services", async (req, res) => {
    const result = await getAllServices();
    res.send(result);
  });

  app.get("/available", async (req, res) => {
    const date = req.query.date;
    const services = await getAvailableServices(date);
    res.send(services);
  });

  app.get("/myappointment", verifyJWT, async (req, res) => {
    const requrestedUser = req.query.email;
    const requestedDate = req.query.date;
    const result = await bookingCollection
      .find({ email: requrestedUser, bookingDate: requestedDate })
      .toArray();

    res.send({ success: true, result });
  });

  app.get("/allusers", verifyJWT, async (req, res) => {
    const allUsers = await userCollection.find({}).toArray();
    res.send(allUsers);
  });

  app.get("/isadmin", async (req, res) => {
    const email = req.query.email;
    const user = await userCollection.findOne({ email });
    if (user?.role === "admin") {
      res.send({ isAdmin: true });
    } else {
      res.send({ isAdmin: false });
    }
  });

  app.get("/servicesName", verifyJWT, async (req, res) => {
    const result = await servicesCollection
      .find({})
      .project({ name: 1 })
      .toArray();
    res.send(result);
  });

  app.get("/singleService/:id", verifyJWT, async (req, res) => {
    const id = req.params.id;
    const query = { _id: ObjectId(id) };
    const result = await bookingCollection.findOne(query);
    res.send(result);
  });

  app.post("/addDoctor", verifyJWT, async (req, res) => {
    const doctor = req.body;
    const result = await doctorsCollection.insertOne(doctor);
    res.send(result);
  });

  app.post("/booking", async (req, res) => {
    const data = req.body;
    const { email, service, bookingDate, timeSlot } = data;

    const exists = await bookingCollection.findOne({
      email,
      service,
      bookingDate,
    });

    if (exists) {
      return res.send({ success: false, booking: exists });
    }
    const result = await bookingCollection.insertOne(data);
    const mailData = {
      to: email,
      subject: `Booking an appointment for ${service} at ${timeSlot} on the data ${bookingDate}.`,
      text: `Hello, You have booked an appointment for ${service}. Let me remind your time slot if you forget, it's at ${timeSlot}. Please make sure you are attend to the meeting.`,
      html: `
      
      <h2>Hello</h2>
      <p>You have booked an appointment for ${service}. Let me remind your time slot if you forget, it's at ${timeSlot}. Please make sure you are attend to the meeting.</p>
      <h4>This is from html</h4>
     
      `,
    };
    sentEmail(mailData);
    res.send({ success: true, result });
  });

  app.post("/create-payment-intent", verifyJWT, async (req, res) => {
    if (!req.body.price || !process.env.STRIPE_SECRET_KEY) {
      return;
    }
    const price = parseFloat(req.body.price) * 100;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: price,
      currency: "usd",
    });

    res.send({
      clientSecret: paymentIntent.client_secret,
    });
  });

  app.put("/getToken/:email", async (req, res) => {
    const email = req.params.email;
    const user = req.body;
    const filter = { email };
    const options = { upsert: true };
    const updatedDoc = {
      $set: user,
    };
    const accessToken = jwt.sign(user, process.env.ACCESS_TOKEN, {
      expiresIn: "1d",
    });
    const result = await userCollection.updateOne(filter, updatedDoc, options);

    res.send({ result, accessToken });
  });

  app.put("/admin/user", verifyJWT, verifyAdmin, async (req, res) => {
    const authorizedUserEmail = req.decoded.email;
    const authorizedUser = await userCollection.findOne({
      email: authorizedUserEmail,
    });
    if (authorizedUser?.role !== "admin") {
      return res.send({ message: "You are not admin" });
    }

    const selectedUserEmail = req.body.email;
    const filter = { email: selectedUserEmail };
    const option = { upsert: true };
    const updatedDoc = {
      $set: {
        role: "admin",
      },
    };
    const result = await userCollection.updateOne(filter, updatedDoc, option);
    res.send(result);
  });

  app.delete("/delete/user", verifyJWT, verifyAdmin, async (req, res) => {
    const selectedUserEmail = req.body.email;
    const result = await userCollection.deleteOne({ email: selectedUserEmail });
    res.send(result);
  });
};
run().catch(console.dir);

app.listen(port, () => console.log("Server is running :D"));
