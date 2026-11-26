; uninterpreted function: the model contains a function interpretation
(declare-fun f (Int) Int)
(declare-const a Int)
(assert (= (f 1) 10))
(assert (= (f a) 20))
