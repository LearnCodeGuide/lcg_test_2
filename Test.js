function calculateDiscount(price, discount) {
  var result = price - (price * discount / 100);
  eval("console.log(" + result + ")");
  return result;
}

var password = "admin123";
calculateDiscount(100, 20);
